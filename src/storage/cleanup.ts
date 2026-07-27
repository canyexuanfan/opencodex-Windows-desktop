/**
 * Phase 2 archived-session cleanup (issue #42 Option A).
 *
 * Preview + execute for files under `archived_sessions/` only. Active `sessions/`
 * are never touched. Default mode quarantines into `CODEX_HOME/.trash/<epoch>/`;
 * permanent delete is opt-in. DB reconciliation probes writability first — on
 * SQLITE_BUSY nothing is moved or deleted.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../codex/home";

export const ARCHIVED_SESSIONS_DIR = "archived_sessions";
export const TRASH_DIR = ".trash";

export type CleanupMode = "quarantine" | "permanent";

export interface ArchivedCandidate {
  /** Path relative to CODEX_HOME, forward-slash separated. */
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
}

export interface CleanupPreview {
  codexHome: string;
  percent: number;
  count: number;
  bytes: number;
  candidates: ArchivedCandidate[];
}

export interface CleanupManifestEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
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
  error?: string;
  removedPaths: string[];
}

const STATE_DB_FILE = /^state_(\d+)\.sqlite$/;

function clampPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
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

/** List archived rollout files oldest-first. Never walks `sessions/`. */
export function listArchivedCandidates(codexHome: string): ArchivedCandidate[] {
  const dir = join(codexHome, ARCHIVED_SESSIONS_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ArchivedCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const absPath = join(dir, name);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      out.push({
        relPath: `${ARCHIVED_SESSIONS_DIR}/${name}`,
        absPath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* vanished mid-scan */
    }
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
  return {
    codexHome,
    percent: clampPercent(percent),
    count: selected.length,
    bytes: selected.reduce((sum, c) => sum + c.bytes, 0),
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
  return db;
}

function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code ?? "";
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked|locked/i.test(msg)
  );
}

/** True when the threads table can be written (BEGIN IMMEDIATE succeeds). */
export function probeStateDbWritable(codexHome: string, busyTimeoutMs = 100): { ok: true; path: string } | { ok: false; error: string } {
  const path = newestStateDb(codexHome);
  if (!path || !existsSync(path)) return { ok: true, path: path ?? "" }; // no DB → FS-only cleanup
  let db: Database | undefined;
  try {
    db = openStateDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { ok: true, path };
  } catch (error) {
    if (isBusyError(error)) return { ok: false, error: "codex_busy" };
    // Missing threads table or corrupt DB: still allow FS cleanup; DB step will soft-skip.
    return { ok: true, path };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

function rolloutPathMatches(candidate: ArchivedCandidate, rolloutPath: string, codexHome: string): boolean {
  const raw = rolloutPath.replace(/\\/g, "/");
  const fileName = basename(candidate.relPath);
  if (raw === candidate.relPath) return true;
  if (raw.endsWith(`/${fileName}`) || raw.endsWith(`\\${fileName}`) || basename(raw) === fileName) return true;
  try {
    const abs = raw.includes(":") || raw.startsWith("/") ? resolve(raw) : resolve(codexHome, raw);
    if (resolve(abs) === resolve(candidate.absPath)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

interface ThreadSnapshot {
  id: string;
  rollout_path: string;
  archived: number | null;
}

function loadMatchingThreads(db: Database, candidates: ArchivedCandidate[], codexHome: string): ThreadSnapshot[] {
  let rows: Array<{ id: string; rollout_path: string; archived?: number | null }> = [];
  try {
    rows = db.query<{ id: string; rollout_path: string; archived: number | null }, []>(
      `SELECT id, rollout_path, archived FROM threads`,
    ).all();
  } catch {
    try {
      rows = db.query<{ id: string; rollout_path: string }, []>(
        `SELECT id, rollout_path FROM threads`,
      ).all().map(r => ({ ...r, archived: null }));
    } catch {
      return [];
    }
  }
  return rows
    .filter(row => candidates.some(c => rolloutPathMatches(c, row.rollout_path, codexHome)))
    .map(row => ({
      id: row.id,
      rollout_path: row.rollout_path,
      archived: row.archived ?? null,
    }));
}

function deleteThreadsAndEdges(db: Database, threadIds: string[]): void {
  if (threadIds.length === 0) return;
  const placeholders = threadIds.map(() => "?").join(",");
  db.run(`DELETE FROM threads WHERE id IN (${placeholders})`, threadIds);
  try {
    db.run(`DELETE FROM thread_spawn_edges WHERE parent_id IN (${placeholders}) OR child_id IN (${placeholders})`, [
      ...threadIds,
      ...threadIds,
    ]);
  } catch {
    try {
      db.run(`DELETE FROM thread_spawn_edges WHERE thread_id IN (${placeholders})`, threadIds);
    } catch {
      /* table absent or unknown schema — ignore */
    }
  }
}

function reconcileThreads(
  stateDbPath: string,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
): { threads: ThreadSnapshot[]; error?: string } {
  if (!stateDbPath || !existsSync(stateDbPath)) return { threads: [] };
  let db: Database | undefined;
  try {
    db = openStateDbWritable(stateDbPath, busyTimeoutMs);
    const threads = loadMatchingThreads(db, candidates, codexHome);
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteThreadsAndEdges(db, threads.map(t => t.id));
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* */ }
      throw error;
    }
    return { threads };
  } catch (error) {
    if (isBusyError(error)) return { threads: [], error: "codex_busy" };
    return { threads: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

export interface ExecuteCleanupOptions {
  percent: number;
  mode: CleanupMode;
  codexHome?: string;
  /** Test-only: shrink busy_timeout so lock tests fail fast. */
  busyTimeoutMs?: number;
  now?: number;
}

/**
 * Execute archived cleanup. Probes DB writability first — on `codex_busy` returns
 * without touching the filesystem.
 */
export function executeArchivedCleanup(options: ExecuteCleanupOptions): CleanupResult {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = clampPercent(options.percent);
  const busyTimeoutMs = options.busyTimeoutMs ?? 100;
  const preview = previewArchivedCleanup(percent, codexHome);
  const empty: CleanupResult = {
    ok: true,
    mode,
    percent,
    count: 0,
    bytes: 0,
    removedPaths: [],
  };
  if (preview.candidates.length === 0) return empty;

  if (mode !== "quarantine" && mode !== "permanent") {
    return { ...empty, ok: false, error: "invalid_mode" };
  }

  const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
  if (!probe.ok) {
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
      error: probe.error,
    };
  }

  // Load matching thread snapshots while the DB is writable, then FS, then delete rows.
  // Quarantine keeps files recoverable if the DB step races into SQLITE_BUSY.
  let threadSnapshots: ThreadSnapshot[] = [];
  if (probe.path && existsSync(probe.path)) {
    let db: Database | undefined;
    try {
      db = openStateDbWritable(probe.path, busyTimeoutMs);
      threadSnapshots = loadMatchingThreads(db, preview.candidates, codexHome);
    } catch (error) {
      if (isBusyError(error)) {
        return {
          ok: false,
          mode,
          percent,
          count: 0,
          bytes: 0,
          removedPaths: [],
          error: "codex_busy",
        };
      }
    } finally {
      try { db?.close(); } catch { /* */ }
    }
  }

  const removedPaths: string[] = [];
  let bytes = 0;
  const epoch = options.now ?? Date.now();
  let trashDir: string | undefined;
  let dbError: string | undefined;

  if (mode === "quarantine") {
    trashDir = join(codexHome, TRASH_DIR, String(epoch));
    mkdirSync(trashDir, { recursive: true });
    const manifestEntries: CleanupManifestEntry[] = [];
    for (const candidate of preview.candidates) {
      const dest = join(trashDir, basename(candidate.relPath));
      renameSync(candidate.absPath, dest);
      removedPaths.push(candidate.relPath);
      bytes += candidate.bytes;
      const thread = threadSnapshots.find(t => rolloutPathMatches(candidate, t.rollout_path, codexHome));
      manifestEntries.push({
        relPath: candidate.relPath,
        bytes: candidate.bytes,
        mtimeMs: candidate.mtimeMs,
        ...(thread
          ? { threadId: thread.id, rolloutPath: thread.rollout_path, archived: thread.archived }
          : {}),
      });
    }
    writeFileSync(
      join(trashDir, "manifest.json"),
      JSON.stringify({
        quarantinedAt: epoch,
        mode: "quarantine",
        percent,
        entries: manifestEntries,
      }, null, 2),
    );
    const dbResult = reconcileThreads(probe.path, preview.candidates, codexHome, busyTimeoutMs);
    dbError = dbResult.error;
  } else {
    // Permanent: reconcile DB first so a lock cannot leave files deleted with rows intact.
    const dbResult = reconcileThreads(probe.path, preview.candidates, codexHome, busyTimeoutMs);
    if (dbResult.error === "codex_busy") {
      return {
        ok: false,
        mode,
        percent,
        count: 0,
        bytes: 0,
        removedPaths: [],
        error: "codex_busy",
      };
    }
    dbError = dbResult.error;
    for (const candidate of preview.candidates) {
      unlinkSync(candidate.absPath);
      removedPaths.push(candidate.relPath);
      bytes += candidate.bytes;
    }
  }

  return {
    ok: true,
    mode,
    percent,
    count: removedPaths.length,
    bytes,
    ...(trashDir ? { trashDir: toForwardSlash(relative(codexHome, trashDir) || trashDir) } : {}),
    ...(dbError ? { error: dbError } : {}),
    removedPaths,
  };
}
