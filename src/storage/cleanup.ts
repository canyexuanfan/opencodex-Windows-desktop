/**
 * Phase 2 archived-session cleanup (issue #42 Option A).
 *
 * Preview + execute for files under `archived_sessions/` only. Active `sessions/`
 * are never touched. Default mode quarantines into `CODEX_HOME/.trash/<epoch>/`;
 * permanent delete is opt-in.
 *
 * Execution is bound to a preview digest. All candidates are staged first; any FS
 * or DB failure rolls staged moves back. DB reconciliation runs in one transaction
 * with foreign keys enabled. Success never carries soft `dbWarning` / `failedPaths`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../codex/home";

export const ARCHIVED_SESSIONS_DIR = "archived_sessions";
export const TRASH_DIR = ".trash";

export type CleanupMode = "quarantine" | "permanent";

/** Mapped failure codes only — never embed absolute host paths. */
export type CleanupErrorCode =
  | "invalid_mode"
  | "invalid_digest"
  | "stale_preview"
  | "codex_busy"
  | "fs_failed"
  | "db_reconcile_failed"
  | "referenced_history"
  | "cleanup_failed";

export interface ArchivedCandidate {
  /** Path relative to CODEX_HOME, forward-slash separated (logical `.jsonl` path). */
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  /** All physical files for this logical rollout (`.jsonl` and/or `.jsonl.zst`). */
  physicalRelPaths: string[];
}

export interface CleanupPreview {
  codexHome: string;
  percent: number;
  count: number;
  bytes: number;
  /** HMAC-free content digest binding execute to this exact candidate set. */
  digest: string;
  candidates: ArchivedCandidate[];
}

export interface CleanupManifestEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
  physicalRelPaths: string[];
  threadId?: string;
  rolloutPath?: string;
  archived?: number | null;
}

export interface CleanupResult {
  ok: boolean;
  mode: CleanupMode;
  percent: number;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: CleanupErrorCode;
  removedPaths: string[];
}

const STATE_DB_FILE = /^state_(\d+)\.sqlite$/;
const JSONL_SUFFIX = ".jsonl";
const ZST_SUFFIX = ".jsonl.zst";

function clampPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}

/** Strip trailing `.zst` so plain + compressed share one logical rollout id. */
export function logicalRolloutRelPath(relPath: string): string {
  const normalized = toForwardSlash(relPath);
  return normalized.endsWith(ZST_SUFFIX)
    ? normalized.slice(0, -".zst".length)
    : normalized;
}

function isRolloutFileName(name: string): boolean {
  return name.endsWith(ZST_SUFFIX) || name.endsWith(JSONL_SUFFIX);
}

function newestStateDb(codexHome: string): string | null {
  let best: string | null = null;
  let bestVersion = -1;
  let names: string[] = [];
  try {
    names = readdirSync(codexHome);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = name.match(STATE_DB_FILE);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best ? join(codexHome, best) : null;
}

/**
 * Normalize a DB `rollout_path` to a CODEX_HOME-relative forward-slash path, then
 * to the logical `.jsonl` form. Returns null when the path is not under
 * `archived_sessions/` (rejects active `sessions/` and foreign paths).
 */
export function normalizeArchivedRolloutPath(rolloutPath: string, codexHome: string): string | null {
  const raw = toForwardSlash(rolloutPath.trim());
  if (!raw) return null;
  let relativePath = raw;
  try {
    // Prefer Node's absolute-path detection. Do not treat a colon anywhere in the
    // filename (Codex ISO timestamps) as an absolute Windows path.
    const looksAbsolute = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    const abs = looksAbsolute ? resolve(raw) : resolve(codexHome, raw);
    const homeAbs = resolve(codexHome);
    const rel = toForwardSlash(relative(homeAbs, abs));
    if (rel.startsWith("..") || rel === "") return null;
    relativePath = rel;
  } catch {
    return null;
  }
  const logical = logicalRolloutRelPath(relativePath);
  if (!logical.startsWith(`${ARCHIVED_SESSIONS_DIR}/`)) return null;
  if (!logical.endsWith(JSONL_SUFFIX)) return null;
  // Reject path tricks: only a single file under archived_sessions/
  const rest = logical.slice(ARCHIVED_SESSIONS_DIR.length + 1);
  if (!rest || rest.includes("/") || rest.includes("..")) return null;
  return logical;
}

/** Content digest of the exact previewed candidate set (paths + size + mtime). */
export function computePreviewDigest(candidates: ArchivedCandidate[], percent: number): string {
  const lines = candidates
    .map(c => {
      const physical = [...c.physicalRelPaths].sort().join(",");
      return `${c.relPath}|${c.bytes}|${Math.trunc(c.mtimeMs)}|${physical}`;
    })
    .sort();
  return createHash("sha256")
    .update(`${clampPercent(percent)}\n${lines.join("\n")}`)
    .digest("hex");
}

/** List archived rollout groups oldest-first. Never walks `sessions/`. */
export function listArchivedCandidates(codexHome: string): ArchivedCandidate[] {
  const dir = join(codexHome, ARCHIVED_SESSIONS_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  type Acc = {
    logicalRel: string;
    files: Array<{ name: string; absPath: string; relPath: string; bytes: number; mtimeMs: number }>;
  };
  const groups = new Map<string, Acc>();

  for (const name of names) {
    if (!isRolloutFileName(name)) continue;
    const absPath = join(dir, name);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      const relPath = `${ARCHIVED_SESSIONS_DIR}/${name}`;
      const logicalRel = logicalRolloutRelPath(relPath);
      let acc = groups.get(logicalRel);
      if (!acc) {
        acc = { logicalRel, files: [] };
        groups.set(logicalRel, acc);
      }
      acc.files.push({
        name,
        absPath,
        relPath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* vanished mid-scan */
    }
  }

  const out: ArchivedCandidate[] = [];
  for (const acc of groups.values()) {
    // Prefer the plain `.jsonl` path as the public/logical identity when both exist.
    acc.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const primary =
      acc.files.find(f => f.relPath === acc.logicalRel) ??
      acc.files[0]!;
    out.push({
      relPath: acc.logicalRel,
      absPath: primary.absPath,
      bytes: acc.files.reduce((sum, f) => sum + f.bytes, 0),
      mtimeMs: Math.min(...acc.files.map(f => f.mtimeMs)),
      physicalRelPaths: acc.files.map(f => f.relPath),
    });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath));
  return out;
}

export function selectOldestPercent(candidates: ArchivedCandidate[], percent: number): ArchivedCandidate[] {
  const pct = clampPercent(percent);
  if (pct <= 0 || candidates.length === 0) return [];
  if (pct >= 100) return [...candidates];
  const n = Math.max(1, Math.floor((candidates.length * pct) / 100));
  return candidates.slice(0, n);
}

export function previewArchivedCleanup(
  percent: number,
  codexHome: string = resolveCodexHomeDir(),
): CleanupPreview {
  const all = listArchivedCandidates(codexHome);
  const selected = selectOldestPercent(all, percent);
  const pct = clampPercent(percent);
  return {
    codexHome,
    percent: pct,
    count: selected.length,
    bytes: selected.reduce((sum, c) => sum + c.bytes, 0),
    digest: computePreviewDigest(selected, pct),
    candidates: selected,
  };
}

function openStateDbWritable(stateDbPath: string, busyTimeoutMs = 100): Database {
  const db = new Database(stateDbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  } catch {
    /* older sqlite */
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    /* ignore */
  }
  return db;
}

function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code ?? "";
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg)
  );
}

function mapDbError(error: unknown): CleanupErrorCode {
  if (isBusyError(error)) return "codex_busy";
  return "db_reconcile_failed";
}

/** True when the threads table can be written (BEGIN IMMEDIATE succeeds). */
export function probeStateDbWritable(codexHome: string, busyTimeoutMs = 100): { ok: true; path: string } | { ok: false; error: CleanupErrorCode } {
  const path = newestStateDb(codexHome);
  if (!path || !existsSync(path)) return { ok: true, path: path ?? "" };
  let db: Database | undefined;
  try {
    db = openStateDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { ok: true, path };
  } catch (error) {
    if (isBusyError(error)) return { ok: false, error: "codex_busy" };
    // Corrupt / unreadable DB must block cleanup so we never orphan rows or files.
    return { ok: false, error: "db_reconcile_failed" };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

interface ThreadSnapshot {
  id: string;
  rollout_path: string;
  archived: number | null;
  history_mode?: string | null;
}

function loadMatchingThreads(db: Database, candidates: ArchivedCandidate[], codexHome: string): ThreadSnapshot[] {
  const logicalSet = new Set(candidates.map(c => c.relPath));
  let rows: Array<{ id: string; rollout_path: string; archived?: number | null; history_mode?: string | null }> = [];
  try {
    rows = db.query<{ id: string; rollout_path: string; archived: number | null; history_mode: string | null }, []>(
      `SELECT id, rollout_path, archived, history_mode FROM threads`,
    ).all();
  } catch {
    try {
      rows = db.query<{ id: string; rollout_path: string; archived: number | null }, []>(
        `SELECT id, rollout_path, archived FROM threads`,
      ).all().map(r => ({ ...r, history_mode: null }));
    } catch {
      try {
        rows = db.query<{ id: string; rollout_path: string }, []>(
          `SELECT id, rollout_path FROM threads`,
        ).all().map(r => ({ ...r, archived: null, history_mode: null }));
      } catch {
        return [];
      }
    }
  }

  return rows
    .filter(row => {
      // When the archived column is present, only archived=1 rows may be deleted.
      if (row.archived !== null && row.archived !== undefined && Number(row.archived) !== 1) {
        return false;
      }
      const normalized = normalizeArchivedRolloutPath(row.rollout_path, codexHome);
      return normalized !== null && logicalSet.has(normalized);
    })
    .map(row => ({
      id: row.id,
      rollout_path: row.rollout_path,
      archived: row.archived ?? null,
      history_mode: row.history_mode ?? null,
    }));
}

/**
 * True when any matched thread is still linked to a thread outside the delete set
 * (spawn edges) or uses paginated history that other live threads may depend on via fork.
 * Throws real DB errors (busy/corruption) so callers can refuse cleanup.
 */
function findReferencedHistory(
  db: Database,
  threads: ThreadSnapshot[],
): boolean {
  if (threads.length === 0) return false;
  const ids = threads.map(t => t.id);
  const idSet = new Set(ids);

  // Paginated history keeps durable projections tied to the rollout — refuse cleanup.
  if (threads.some(t => (t.history_mode ?? "").toLowerCase() === "paginated")) {
    return true;
  }

  // Spawn edges that cross the delete boundary keep history reachable.
  if (tableExists(db, "thread_spawn_edges")) {
    const placeholders = ids.map(() => "?").join(",");
    const edges = db.query<{ parent_thread_id: string; child_thread_id: string }, string[]>(
      `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges
       WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
    ).all(...ids, ...ids);
    for (const edge of edges) {
      if (!idSet.has(edge.parent_thread_id) || !idSet.has(edge.child_thread_id)) {
        return true;
      }
    }
  }

  // Other threads that list one of ours as forked_from / parent (when columns exist).
  for (const column of ["forked_from_id", "parent_thread_id", "source_thread_id"] as const) {
    if (!columnExists(db, "threads", column)) continue;
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.query<{ id: string }, string[]>(
      `SELECT id FROM threads WHERE ${column} IN (${placeholders})`,
    ).all(...ids);
    if (rows.some(r => !idSet.has(r.id))) return true;
  }

  return false;
}

function tableExists(db: Database, name: string): boolean {
  try {
    const row = db.query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  try {
    // table name already verified via sqlite_master; quote for safety.
    const rows = db.query<{ name: string }, []>(
      `PRAGMA table_info(${JSON.stringify(table)})`,
    ).all();
    return rows.some(r => r.name === column);
  } catch (error) {
    // Real pragma failures must not look like "column missing".
    throw error;
  }
}

function deleteThreadsAndDependents(db: Database, threadIds: string[]): void {
  if (threadIds.length === 0) return;
  const placeholders = threadIds.map(() => "?").join(",");

  // Real Codex schema columns.
  if (tableExists(db, "thread_spawn_edges")) {
    db.run(
      `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
      [...threadIds, ...threadIds],
    );
  }

  // Explicit dependent cleanup even when FK pragma is ignored by older builds.
  if (tableExists(db, "thread_dynamic_tools")) {
    db.run(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`, threadIds);
  }

  db.run(`DELETE FROM threads WHERE id IN (${placeholders})`, threadIds);
}

interface ReconcileOk {
  ok: true;
  threads: ThreadSnapshot[];
}
interface ReconcileErr {
  ok: false;
  error: CleanupErrorCode;
}

function reconcileThreads(
  stateDbPath: string,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
): ReconcileOk | ReconcileErr {
  if (!stateDbPath || !existsSync(stateDbPath)) return { ok: true, threads: [] };
  let db: Database | undefined;
  try {
    db = openStateDbWritable(stateDbPath, busyTimeoutMs);
    const threads = loadMatchingThreads(db, candidates, codexHome);
    if (findReferencedHistory(db, threads)) {
      return { ok: false, error: "referenced_history" };
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteThreadsAndDependents(db, threads.map(t => t.id));
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* */ }
      throw error;
    }
    return { ok: true, threads };
  } catch (error) {
    return { ok: false, error: mapDbError(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

function absFromRel(codexHome: string, relPath: string): string {
  return join(codexHome, ...relPath.split("/"));
}

function stageCandidates(
  codexHome: string,
  candidates: ArchivedCandidate[],
  stageDir: string,
): { ok: true; staged: Array<{ from: string; to: string; relPath: string }> } | { ok: false; staged: Array<{ from: string; to: string; relPath: string }> } {
  const staged: Array<{ from: string; to: string; relPath: string }> = [];
  const usedBasenames = new Set<string>();
  try {
    mkdirSync(stageDir, { recursive: true });
    for (const candidate of candidates) {
      for (const rel of candidate.physicalRelPaths) {
        const from = absFromRel(codexHome, rel);
        const base = basename(rel);
        // archived_sessions/ is flat today; refuse collisions so a future nested walk
        // cannot silently overwrite another staged file.
        if (usedBasenames.has(base)) {
          throw new Error("stage_basename_collision");
        }
        usedBasenames.add(base);
        const to = join(stageDir, base);
        renameSync(from, to);
        staged.push({ from, to, relPath: rel });
      }
    }
    return { ok: true, staged };
  } catch {
    return { ok: false, staged };
  }
}

function rollbackStaged(staged: Array<{ from: string; to: string }>): void {
  for (let i = staged.length - 1; i >= 0; i--) {
    const item = staged[i]!;
    try {
      if (existsSync(item.to) && !existsSync(item.from)) {
        renameSync(item.to, item.from);
      }
    } catch {
      /* best-effort restore */
    }
  }
}

function purgeStaged(staged: Array<{ to: string }>): boolean {
  let ok = true;
  for (const item of staged) {
    try {
      unlinkSync(item.to);
    } catch {
      ok = false;
    }
  }
  return ok;
}

export interface ExecuteCleanupOptions {
  percent: number;
  mode: CleanupMode;
  /** Required digest from preview; rejects when the candidate set drifted. */
  digest: string;
  codexHome?: string;
  /** Test-only: shrink busy_timeout so lock tests fail fast. */
  busyTimeoutMs?: number;
  now?: number;
}

function fail(
  mode: CleanupMode,
  percent: number,
  error: CleanupErrorCode,
): CleanupResult {
  return {
    ok: false,
    mode,
    percent,
    count: 0,
    bytes: 0,
    removedPaths: [],
    error,
  };
}

/**
 * Execute archived cleanup bound to a preview digest.
 * Stages every physical file first; rolls back on any FS or DB failure.
 */
export function executeArchivedCleanup(options: ExecuteCleanupOptions): CleanupResult {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = clampPercent(options.percent);
  const busyTimeoutMs = options.busyTimeoutMs ?? 100;

  if (mode !== "quarantine" && mode !== "permanent") {
    return fail(mode, percent, "invalid_mode");
  }
  if (typeof options.digest !== "string" || !/^[a-f0-9]{64}$/i.test(options.digest)) {
    return fail(mode, percent, "invalid_digest");
  }

  const preview = previewArchivedCleanup(percent, codexHome);
  if (preview.digest.toLowerCase() !== options.digest.toLowerCase()) {
    return fail(mode, percent, "stale_preview");
  }

  if (preview.candidates.length === 0) {
    return {
      ok: true,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
    };
  }

  const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
  if (!probe.ok) {
    return fail(mode, percent, probe.error);
  }

  // Preflight referenced-history / matching while DB is free, before any rename.
  if (probe.path && existsSync(probe.path)) {
    let db: Database | undefined;
    try {
      db = openStateDbWritable(probe.path, busyTimeoutMs);
      const threads = loadMatchingThreads(db, preview.candidates, codexHome);
      if (findReferencedHistory(db, threads)) {
        return fail(mode, percent, "referenced_history");
      }
    } catch (error) {
      return fail(mode, percent, mapDbError(error));
    } finally {
      try { db?.close(); } catch { /* */ }
    }
  }

  const epoch = options.now ?? Date.now();
  const stageDir = join(codexHome, TRASH_DIR, String(epoch));
  const stageResult = stageCandidates(codexHome, preview.candidates, stageDir);
  if (!stageResult.ok) {
    rollbackStaged(stageResult.staged);
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
    return fail(mode, percent, "fs_failed");
  }

  const dbResult = reconcileThreads(probe.path, preview.candidates, codexHome, busyTimeoutMs);
  if (!dbResult.ok) {
    rollbackStaged(stageResult.staged);
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
    return fail(mode, percent, dbResult.error);
  }

  const removedPaths = preview.candidates.map(c => c.relPath);
  const bytes = preview.candidates.reduce((sum, c) => sum + c.bytes, 0);
  const trashRel = toForwardSlash(relative(codexHome, stageDir) || stageDir);

  const manifestEntries: CleanupManifestEntry[] = preview.candidates.map(candidate => {
    const thread = dbResult.threads.find(t => {
      const normalized = normalizeArchivedRolloutPath(t.rollout_path, codexHome);
      return normalized === candidate.relPath;
    });
    return {
      relPath: candidate.relPath,
      bytes: candidate.bytes,
      mtimeMs: candidate.mtimeMs,
      physicalRelPaths: candidate.physicalRelPaths,
      ...(thread
        ? { threadId: thread.id, rolloutPath: thread.rollout_path, archived: thread.archived }
        : {}),
    };
  });

  const writeManifest = (manifestMode: CleanupMode): boolean => {
    try {
      writeFileSync(
        join(stageDir, "manifest.json"),
        JSON.stringify({
          quarantinedAt: epoch,
          mode: manifestMode,
          percent,
          digest: preview.digest,
          entries: manifestEntries,
        }, null, 2),
      );
      return true;
    } catch {
      return false;
    }
  };

  if (mode === "quarantine") {
    if (!writeManifest("quarantine")) {
      rollbackStaged(stageResult.staged);
      try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
      return fail(mode, percent, "fs_failed");
    }
    return {
      ok: true,
      mode,
      percent,
      count: removedPaths.length,
      bytes,
      trashDir: trashRel,
      removedPaths,
    };
  }

  // Permanent: purge staged files only after a successful DB commit.
  if (!purgeStaged(stageResult.staged)) {
    // DB already committed; leave remnants in stage with a manifest for manual recovery.
    writeManifest("permanent");
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      trashDir: trashRel,
      removedPaths: [],
      error: "fs_failed",
    };
  }
  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* empty dir */ }
  // Drop an empty `.trash` root so permanent cleanup leaves no quarantine tree behind.
  try {
    const trashRoot = join(codexHome, TRASH_DIR);
    if (existsSync(trashRoot) && readdirSync(trashRoot).length === 0) {
      rmSync(trashRoot, { recursive: true, force: true });
    }
  } catch { /* */ }

  return {
    ok: true,
    mode,
    percent,
    count: removedPaths.length,
    bytes,
    removedPaths,
  };
}
