/**
 * Phase 2 archived-session cleanup (issue #42 Option A).
 *
 * Preview + execute for files under `archived_sessions/` only. Active `sessions/`
 * are never touched. Default mode quarantines into `CODEX_HOME/.trash/<epoch>/`;
 * permanent delete is opt-in.
 *
 * Execution is bound to a preview digest. All candidates are staged first; any FS
 * Freezes the thread-ID set under the state write lock, persists a complete
 * satellite-backup.json before any satellite delete commit, then mutates
 * `logs_*` → `memories_*` → `goals_*` → `state_*`. Later failures restore
 * satellite rows before staged files. Success never carries soft `dbWarning` /
 * `failedPaths`.
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
const LOGS_DB_FILE = /^logs_(\d+)\.sqlite$/;
const GOALS_DB_FILE = /^goals_(\d+)\.sqlite$/;
const MEMORIES_DB_FILE = /^memories_(\d+)\.sqlite$/;
const JSONL_SUFFIX = ".jsonl";
const ZST_SUFFIX = ".jsonl.zst";
const JOB_KIND_MEMORY_STAGE1 = "memory_stage1";
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL = "memory_consolidate_global";
const MEMORY_CONSOLIDATION_JOB_KEY = "global";
const DEFAULT_RETRY_REMAINING = 3;

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

/** Newest `prefix_N.sqlite` under CODEX_HOME, or null when absent. */
function newestVersionedDb(codexHome: string, pattern: RegExp): string | null {
  let best: string | null = null;
  let bestVersion = -1;
  let names: string[] = [];
  try {
    names = readdirSync(codexHome);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = name.match(pattern);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best ? join(codexHome, best) : null;
}

function newestStateDb(codexHome: string): string | null {
  return newestVersionedDb(codexHome, STATE_DB_FILE);
}

interface RuntimeDbPaths {
  state: string | null;
  logs: string | null;
  goals: string | null;
  memories: string | null;
}

function discoverRuntimeDbPaths(codexHome: string): RuntimeDbPaths {
  return {
    state: newestVersionedDb(codexHome, STATE_DB_FILE),
    logs: newestVersionedDb(codexHome, LOGS_DB_FILE),
    goals: newestVersionedDb(codexHome, GOALS_DB_FILE),
    memories: newestVersionedDb(codexHome, MEMORIES_DB_FILE),
  };
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

function openDbWritable(dbPath: string, busyTimeoutMs = 100): Database {
  const db = new Database(dbPath);
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

/** Probe a single DB with BEGIN IMMEDIATE; missing path is a no-op success. */
function probeDbWritable(
  path: string | null,
  busyTimeoutMs: number,
): { ok: true } | { ok: false; error: CleanupErrorCode } {
  if (!path || !existsSync(path)) return { ok: true };
  let db: Database | undefined;
  try {
    db = openDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { ok: true };
  } catch (error) {
    if (isBusyError(error)) return { ok: false, error: "codex_busy" };
    return { ok: false, error: "db_reconcile_failed" };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * True when every present Codex runtime DB can be written (BEGIN IMMEDIATE).
 * Busy / corrupt stores abort cleanup before any filesystem mutation.
 */
export function probeStateDbWritable(
  codexHome: string,
  busyTimeoutMs = 100,
): { ok: true; path: string } | { ok: false; error: CleanupErrorCode } {
  const paths = discoverRuntimeDbPaths(codexHome);
  for (const path of [paths.state, paths.logs, paths.goals, paths.memories]) {
    const probed = probeDbWritable(path, busyTimeoutMs);
    if (!probed.ok) return probed;
  }
  return { ok: true, path: paths.state ?? "" };
}

interface ThreadSnapshot {
  id: string;
  rollout_path: string;
  archived: number | null;
  history_mode?: string | null;
}

/**
 * Load archived threads matching the candidate set.
 * Optional columns are detected via PRAGMA; missing `threads` / query failures throw
 * so callers map to `db_reconcile_failed` / `codex_busy` instead of treating them as empty.
 */
function loadMatchingThreads(db: Database, candidates: ArchivedCandidate[], codexHome: string): ThreadSnapshot[] {
  if (!tableExists(db, "threads")) {
    throw new Error("missing_threads_table");
  }
  const logicalSet = new Set(candidates.map(c => c.relPath));
  const hasArchived = columnExists(db, "threads", "archived");
  const hasHistoryMode = columnExists(db, "threads", "history_mode");
  const selectCols = ["id", "rollout_path"];
  if (hasArchived) selectCols.push("archived");
  if (hasHistoryMode) selectCols.push("history_mode");
  const rows = db.query<
    { id: string; rollout_path: string; archived?: number | null; history_mode?: string | null },
    []
  >(`SELECT ${selectCols.join(", ")} FROM threads`).all();

  return rows
    .filter(row => {
      // When the archived column is present, only archived=1 rows may be deleted.
      if (hasArchived && Number(row.archived ?? 0) !== 1) {
        return false;
      }
      const normalized = normalizeArchivedRolloutPath(row.rollout_path, codexHome);
      return normalized !== null && logicalSet.has(normalized);
    })
    .map(row => ({
      id: row.id,
      rollout_path: row.rollout_path,
      archived: hasArchived ? (row.archived ?? null) : null,
      history_mode: hasHistoryMode ? (row.history_mode ?? null) : null,
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
  const row = db.query<{ name: string }, [string]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name);
  return Boolean(row);
}

function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  // `table` is only ever a hardcoded identifier already verified via sqlite_master.
  const rows = db.query<{ name: string }, []>(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all();
  return rows.some(r => r.name === column);
}

function deleteThreadsAndDependents(db: Database, threadIds: string[]): void {
  if (threadIds.length === 0) return;
  const placeholders = threadIds.map(() => "?").join(",");

  // Upstream deletes dynamic tools before spawn edges before threads.
  if (tableExists(db, "thread_dynamic_tools")) {
    db.run(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`, threadIds);
  }

  if (tableExists(db, "thread_spawn_edges")) {
    db.run(
      `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
      [...threadIds, ...threadIds],
    );
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
  /** True when satellite rows were mutated and could not all be restored. */
  satelliteRestoreFailed?: boolean;
}

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

interface SatelliteBackup {
  threadIds: string[];
  logs?: { path: string; rows: SqlRow[] };
  memories?: {
    path: string;
    stage1: SqlRow[];
    stage1Jobs: SqlRow[];
    consolidateJob: SqlRow | null;
    consolidateTouched: boolean;
  };
  goals?: {
    path: string;
    goals: SqlRow[];
    deferrals: SqlRow[];
  };
}

interface ReconcileTestHooks {
  failAfterLogsMutation?: boolean;
  failAfterMemoriesMutation?: boolean;
  failAfterGoalsMutation?: boolean;
  failBeforeStateCommit?: boolean;
  failSatelliteRestore?: boolean;
  failSatelliteBackupWrite?: boolean;
  /** Runs after satellite deletes are committed, before state thread deletion. */
  afterSatelliteMutations?: () => void;
}

const SATELLITE_BACKUP_FILE = "satellite-backup.json";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function selectRows(db: Database, sql: string, params: Array<string | number>): SqlRow[] {
  return db.query<SqlRow, Array<string | number>>(sql).all(...params) as SqlRow[];
}

function insertRowsConflictIgnore(db: Database, table: string, rows: SqlRow[]): void {
  for (const row of rows) {
    const cols = Object.keys(row);
    if (cols.length === 0) continue;
    db.run(
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
      cols.map(c => row[c] as string | number | bigint | null | Uint8Array),
    );
  }
}

function updateRowFromSnapshot(
  db: Database,
  table: string,
  row: SqlRow,
  pkCols: string[],
): void {
  const cols = Object.keys(row).filter(c => !pkCols.includes(c));
  if (cols.length === 0) return;
  const sets = cols.map(c => `${quoteIdent(c)} = ?`).join(", ");
  const where = pkCols.map(c => `${quoteIdent(c)} = ?`).join(" AND ");
  db.run(
    `UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${where}`,
  [
    ...cols.map(c => row[c] as string | number | bigint | null | Uint8Array),
    ...pkCols.map(c => row[c] as string | number | bigint | null | Uint8Array),
  ],
  );
}

/** Revert delete-time consolidate enqueue; preserve concurrent post-commit status changes. */
function restoreConsolidateGlobalJob(db: Database, snapshot: SqlRow): void {
  const kind = String(snapshot.kind);
  const jobKey = String(snapshot.job_key);
  const existing = db.query<{ status: string }, [string, string]>(
    "SELECT status FROM jobs WHERE kind = ? AND job_key = ?",
  ).get(kind, jobKey);
  if (!existing) {
    insertRowsConflictIgnore(db, "jobs", [snapshot]);
    return;
  }
  const snapStatus = String(snapshot.status ?? "");
  const currentStatus = String(existing.status ?? "");
  if (currentStatus === "pending" && snapStatus !== "pending") {
    updateRowFromSnapshot(db, "jobs", snapshot, ["kind", "job_key"]);
  }
}

function writeSatelliteBackup(stageDir: string, backup: SatelliteBackup): void {
  writeFileSync(join(stageDir, SATELLITE_BACKUP_FILE), JSON.stringify(backup), "utf8");
}

function clearSatelliteBackup(stageDir: string): void {
  try { unlinkSync(join(stageDir, SATELLITE_BACKUP_FILE)); } catch { /* */ }
}

interface SatelliteWriteLock {
  path: string;
  db: Database;
}

interface SatelliteWriteLocks {
  logs?: SatelliteWriteLock;
  memories?: SatelliteWriteLock;
  goals?: SatelliteWriteLock;
}

/** Deterministic order: logs → memories → goals. Each present DB gets BEGIN IMMEDIATE. */
function beginSatelliteWriteLocks(
  paths: RuntimeDbPaths,
  busyTimeoutMs: number,
): SatelliteWriteLocks {
  const begin = (path: string | null): SatelliteWriteLock | undefined => {
    if (!path || !existsSync(path)) return undefined;
    const db = openDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    return { path, db };
  };
  return {
    logs: begin(paths.logs),
    memories: begin(paths.memories),
    goals: begin(paths.goals),
  };
}

function rollbackSatelliteLock(lock: SatelliteWriteLock | undefined): void {
  if (!lock) return;
  try { lock.db.exec("ROLLBACK"); } catch { /* */ }
  try { lock.db.close(); } catch { /* */ }
}

function rollbackAllSatelliteLocks(locks: SatelliteWriteLocks): void {
  rollbackSatelliteLock(locks.logs);
  rollbackSatelliteLock(locks.memories);
  rollbackSatelliteLock(locks.goals);
  locks.logs = undefined;
  locks.memories = undefined;
  locks.goals = undefined;
}

function commitSatelliteLock(lock: SatelliteWriteLock | undefined): void {
  if (!lock) return;
  lock.db.exec("COMMIT");
  lock.db.close();
}

function snapshotLogsInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["logs"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
  const placeholders = threadIds.map(() => "?").join(",");
  const rows = selectRows(db, `SELECT * FROM logs WHERE thread_id IN (${placeholders})`, threadIds);
  return { path, rows };
}

function snapshotMemoriesInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["memories"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
  const placeholders = threadIds.map(() => "?").join(",");
  const stage1 = selectRows(
    db,
    `SELECT * FROM stage1_outputs WHERE thread_id IN (${placeholders})`,
    threadIds,
  );
  let stage1Jobs: SqlRow[] = [];
  let consolidateJob: SqlRow | null = null;
  let selectedForPhase2 = 0;
  if (columnExists(db, "stage1_outputs", "selected_for_phase2")) {
    selectedForPhase2 = stage1.filter(r => Number(r.selected_for_phase2 ?? 0) !== 0).length;
  }
  if (tableExists(db, "jobs")) {
    stage1Jobs = selectRows(
      db,
      `SELECT * FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`,
      [JOB_KIND_MEMORY_STAGE1, ...threadIds],
    );
    consolidateJob = db.query<SqlRow, [string, string]>(
      `SELECT * FROM jobs WHERE kind = ? AND job_key = ?`,
    ).get(JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY) as SqlRow | null;
  }
  return {
    path,
    stage1,
    stage1Jobs,
    consolidateJob,
    consolidateTouched: selectedForPhase2 > 0,
  };
}

function snapshotGoalsInTx(
  db: Database,
  path: string,
  threadIds: string[],
): SatelliteBackup["goals"] {
  if (threadIds.length === 0) return undefined;
  if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
  const placeholders = threadIds.map(() => "?").join(",");
  const goals = selectRows(
    db,
    `SELECT * FROM thread_goals WHERE thread_id IN (${placeholders})`,
    threadIds,
  );
  let deferrals: SqlRow[] = [];
  if (tableExists(db, "thread_goal_continuation_deferrals")) {
    deferrals = selectRows(
      db,
      `SELECT * FROM thread_goal_continuation_deferrals WHERE thread_id IN (${placeholders})`,
      threadIds,
    );
  }
  return { path, goals, deferrals };
}

/** Snapshot every present satellite under its write lock (rows stable until commit). */
function snapshotSatelliteBackupInLocks(
  locks: SatelliteWriteLocks,
  threadIds: string[],
): SatelliteBackup {
  const backup: SatelliteBackup = { threadIds };
  if (locks.logs) {
    backup.logs = snapshotLogsInTx(locks.logs.db, locks.logs.path, threadIds);
  }
  if (locks.memories) {
    backup.memories = snapshotMemoriesInTx(locks.memories.db, locks.memories.path, threadIds);
  }
  if (locks.goals) {
    backup.goals = snapshotGoalsInTx(locks.goals.db, locks.goals.path, threadIds);
  }
  return backup;
}

function deleteLogsInTx(db: Database, rows: SqlRow[]): void {
  if (rows.length === 0) return;
  if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
  const ids = rows.map(r => r.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(`DELETE FROM logs WHERE id IN (${placeholders})`, ids as Array<string | number>);
}

function deleteMemoriesInTx(
  db: Database,
  section: NonNullable<SatelliteBackup["memories"]>,
): void {
  if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
  const stage1Ids = section.stage1.map(r => String(r.thread_id));
  if (stage1Ids.length > 0) {
    const placeholders = stage1Ids.map(() => "?").join(",");
    db.run(`DELETE FROM stage1_outputs WHERE thread_id IN (${placeholders})`, stage1Ids);
  }
  if (tableExists(db, "jobs")) {
    const jobKeys = section.stage1Jobs.map(r => String(r.job_key));
    if (jobKeys.length > 0) {
      const placeholders = jobKeys.map(() => "?").join(",");
      db.run(
        `DELETE FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`,
        [JOB_KIND_MEMORY_STAGE1, ...jobKeys],
      );
    }
    if (section.consolidateTouched) {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO jobs (
           kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
           lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark
         ) VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, 0)
         ON CONFLICT(kind, job_key) DO UPDATE SET
           status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
           retry_at = CASE WHEN jobs.status = 'running' THEN jobs.retry_at ELSE NULL END,
           retry_remaining = max(jobs.retry_remaining, excluded.retry_remaining),
           input_watermark = CASE
             WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, 0)
             THEN excluded.input_watermark
             ELSE COALESCE(jobs.input_watermark, 0) + 1
           END`,
        [JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, MEMORY_CONSOLIDATION_JOB_KEY, DEFAULT_RETRY_REMAINING, now],
      );
    }
  }
}

function deleteGoalsInTx(
  db: Database,
  section: NonNullable<SatelliteBackup["goals"]>,
): void {
  if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
  const deferralIds = section.deferrals.map(r => String(r.thread_id));
  if (deferralIds.length > 0 && tableExists(db, "thread_goal_continuation_deferrals")) {
    const placeholders = deferralIds.map(() => "?").join(",");
    db.run(
      `DELETE FROM thread_goal_continuation_deferrals WHERE thread_id IN (${placeholders})`,
      deferralIds,
    );
  }
  const goalIds = section.goals.map(r => String(r.thread_id));
  if (goalIds.length > 0) {
    const placeholders = goalIds.map(() => "?").join(",");
    db.run(`DELETE FROM thread_goals WHERE thread_id IN (${placeholders})`, goalIds);
  }
}

/** Delete snapshotted primary-key rows and commit each satellite write transaction. */
function deleteAndCommitSatellites(
  locks: SatelliteWriteLocks,
  backup: SatelliteBackup,
  hooks?: ReconcileTestHooks,
): void {
  try {
    if (locks.logs && backup.logs) {
      deleteLogsInTx(locks.logs.db, backup.logs.rows);
      commitSatelliteLock(locks.logs);
      locks.logs = undefined;
      if (hooks?.failAfterLogsMutation) throw new Error("test_fail_after_logs");
    }
    if (locks.memories && backup.memories) {
      deleteMemoriesInTx(locks.memories.db, backup.memories);
      commitSatelliteLock(locks.memories);
      locks.memories = undefined;
      if (hooks?.failAfterMemoriesMutation) throw new Error("test_fail_after_memories");
    }
    if (locks.goals && backup.goals) {
      deleteGoalsInTx(locks.goals.db, backup.goals);
      commitSatelliteLock(locks.goals);
      locks.goals = undefined;
      if (hooks?.failAfterGoalsMutation) throw new Error("test_fail_after_goals");
    }
  } catch (error) {
    rollbackAllSatelliteLocks(locks);
    throw error;
  }
}

/** Restore only snapshotted rows; concurrent inserts/updates after commit stay intact. */
function restoreSatelliteBackup(
  backup: SatelliteBackup,
  busyTimeoutMs: number,
  failRestore = false,
): boolean {
  if (failRestore) return false;
  try {
    if (backup.logs) {
      const restored = withWritableDb(backup.logs.path, busyTimeoutMs, db => {
        if (!tableExists(db, "logs")) throw new Error("missing_logs_table");
        insertRowsConflictIgnore(db, "logs", backup.logs!.rows);
      });
      if (!restored.ok) return false;
    }
    if (backup.memories) {
      const mem = backup.memories;
      const restored = withWritableDb(mem.path, busyTimeoutMs, db => {
        if (!tableExists(db, "stage1_outputs")) throw new Error("missing_stage1_outputs_table");
        insertRowsConflictIgnore(db, "stage1_outputs", mem.stage1);
        if (tableExists(db, "jobs")) {
          insertRowsConflictIgnore(db, "jobs", mem.stage1Jobs);
          if (mem.consolidateTouched && mem.consolidateJob) {
            restoreConsolidateGlobalJob(db, mem.consolidateJob);
          }
        }
      });
      if (!restored.ok) return false;
    }
    if (backup.goals) {
      const g = backup.goals;
      const restored = withWritableDb(g.path, busyTimeoutMs, db => {
        if (!tableExists(db, "thread_goals")) throw new Error("missing_thread_goals_table");
        insertRowsConflictIgnore(db, "thread_goals", g.goals);
        if (tableExists(db, "thread_goal_continuation_deferrals")) {
          insertRowsConflictIgnore(db, "thread_goal_continuation_deferrals", g.deferrals);
        }
      });
      if (!restored.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function withWritableDb(
  path: string,
  busyTimeoutMs: number,
  body: (db: Database) => void,
): { ok: true } | ReconcileErr {
  let db: Database | undefined;
  try {
    db = openDbWritable(path, busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    try {
      body(db);
      db.exec("COMMIT");
      return { ok: true };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* */ }
      throw error;
    }
  } catch (error) {
    return { ok: false, error: mapDbError(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** Load matching archived threads and refuse referenced history — no deletes yet. */
function loadThreadsForCleanup(
  stateDbPath: string,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
): ReconcileOk | ReconcileErr {
  if (!stateDbPath || !existsSync(stateDbPath)) return { ok: true, threads: [] };
  let db: Database | undefined;
  try {
    db = openDbWritable(stateDbPath, busyTimeoutMs);
    const threads = loadMatchingThreads(db, candidates, codexHome);
    if (findReferencedHistory(db, threads)) {
      return { ok: false, error: "referenced_history" };
    }
    return { ok: true, threads };
  } catch (error) {
    return { ok: false, error: mapDbError(error) };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * Reconcile all Codex per-thread stores for the matched archived candidates.
 *
 * Freezes the thread-ID set under the state write lock, persists a complete
 * satellite backup, then mutates satellites (logs → memories → goals). Any later
 * failure restores satellite rows before the caller restores staged files.
 */
function reconcileDeletedThreads(
  paths: RuntimeDbPaths,
  candidates: ArchivedCandidate[],
  codexHome: string,
  busyTimeoutMs: number,
  stageDir: string,
  hooks?: ReconcileTestHooks,
): ReconcileOk | ReconcileErr {
  if (!paths.state || !existsSync(paths.state)) return { ok: true, threads: [] };

  let stateDb: Database | undefined;
  let backup: SatelliteBackup | undefined;
  let satellitesMutated = false;
  let satelliteLocks: SatelliteWriteLocks | undefined;

  const failWithRestore = (error: CleanupErrorCode, mapped?: CleanupErrorCode): ReconcileErr => {
    const code = mapped ?? error;
    let satelliteRestoreFailed = false;
    if (satellitesMutated && backup) {
      satelliteRestoreFailed = !restoreSatelliteBackup(
        backup,
        busyTimeoutMs,
        Boolean(hooks?.failSatelliteRestore),
      );
      // Keep on-disk backup + manifest when restore cannot complete.
      if (!satelliteRestoreFailed) clearSatelliteBackup(stageDir);
    } else {
      clearSatelliteBackup(stageDir);
    }
    return {
      ok: false,
      error: code,
      ...(satelliteRestoreFailed ? { satelliteRestoreFailed: true } : {}),
    };
  };

  try {
    stateDb = openDbWritable(paths.state, busyTimeoutMs);
    stateDb.exec("BEGIN IMMEDIATE");

    // Freeze the exact delete set under the write lock before any satellite mutation.
    const threads = loadMatchingThreads(stateDb, candidates, codexHome);
    if (findReferencedHistory(stateDb, threads)) {
      stateDb.exec("ROLLBACK");
      return { ok: false, error: "referenced_history" };
    }
    const threadIds = threads.map(t => t.id);

    satelliteLocks = beginSatelliteWriteLocks(paths, busyTimeoutMs);
    try {
      backup = snapshotSatelliteBackupInLocks(satelliteLocks, threadIds);
      try {
        if (hooks?.failSatelliteBackupWrite) {
          throw new Error("test_fail_satellite_backup_write");
        }
        writeSatelliteBackup(stageDir, backup);
      } catch {
        rollbackAllSatelliteLocks(satelliteLocks);
        stateDb.exec("ROLLBACK");
        clearSatelliteBackup(stageDir);
        return { ok: false, error: "fs_failed" };
      }

      const hasSatelliteWork = Boolean(backup.logs || backup.memories || backup.goals);
      if (hasSatelliteWork) {
        satellitesMutated = true;
        deleteAndCommitSatellites(satelliteLocks, backup, hooks);
      } else {
        rollbackAllSatelliteLocks(satelliteLocks);
      }
      satelliteLocks = undefined;

      if (hooks?.afterSatelliteMutations) hooks.afterSatelliteMutations();

      // Re-check under the same lock before committing state deletes.
      if (findReferencedHistory(stateDb, threads)) {
        stateDb.exec("ROLLBACK");
        return failWithRestore("referenced_history");
      }
      deleteThreadsAndDependents(stateDb, threadIds);
      if (hooks?.failBeforeStateCommit) throw new Error("test_fail_before_state_commit");
      stateDb.exec("COMMIT");
      clearSatelliteBackup(stageDir);
      return { ok: true, threads };
    } catch (error) {
      if (satelliteLocks) rollbackAllSatelliteLocks(satelliteLocks);
      throw error;
    }
  } catch (error) {
    try { stateDb?.exec("ROLLBACK"); } catch { /* */ }
    return failWithRestore("db_reconcile_failed", mapDbError(error));
  } finally {
    try { stateDb?.close(); } catch { /* */ }
  }
}

type StagedFile = { from: string; to: string; relPath: string };

function absFromRel(codexHome: string, relPath: string): string {
  return join(codexHome, ...relPath.split("/"));
}

function stageCandidates(
  codexHome: string,
  candidates: ArchivedCandidate[],
  stageDir: string,
): { ok: true; staged: StagedFile[] } | { ok: false; staged: StagedFile[] } {
  const staged: StagedFile[] = [];
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

/**
 * Rename staged files back to their originals.
 * Returns whether every staged file was restored. Unrestored entries stay in `remaining`.
 */
function rollbackStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { restored: boolean; remaining: StagedFile[] } {
  const remaining: StagedFile[] = [];
  for (let i = staged.length - 1; i >= 0; i--) {
    const item = staged[i]!;
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      if (existsSync(item.to) && !existsSync(item.from)) {
        renameSync(item.to, item.from);
      } else if (existsSync(item.to)) {
        // Destination occupied — cannot restore without clobbering.
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  return { restored: remaining.length === 0, remaining };
}

function purgeStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { purged: StagedFile[]; remaining: StagedFile[] } {
  const purged: StagedFile[] = [];
  const remaining: StagedFile[] = [];
  for (const item of staged) {
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      unlinkSync(item.to);
      purged.push(item);
    } catch {
      remaining.push(item);
    }
  }
  return { purged, remaining };
}

/** Remove stageDir only when it contains no unrestored staged files. */
function removeStageIfEmpty(stageDir: string, remaining: StagedFile[]): void {
  if (remaining.length > 0) return;
  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
}

function removeEmptyTrashRoot(codexHome: string): void {
  try {
    const trashRoot = join(codexHome, TRASH_DIR);
    if (existsSync(trashRoot) && readdirSync(trashRoot).length === 0) {
      rmSync(trashRoot, { recursive: true, force: true });
    }
  } catch { /* */ }
}

function trashRelPath(codexHome: string, stageDir: string): string {
  return toForwardSlash(relative(codexHome, stageDir) || stageDir);
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
  /** Test-only failure injection for atomicity regressions. */
  _test?: {
    failManifestWrite?: boolean;
    failPurgeBasenames?: string[];
    failRollbackBasenames?: string[];
    failAfterLogsMutation?: boolean;
    failAfterMemoriesMutation?: boolean;
    failAfterGoalsMutation?: boolean;
    failBeforeStateCommit?: boolean;
    failSatelliteRestore?: boolean;
    failSatelliteBackupWrite?: boolean;
    afterSatelliteMutations?: () => void;
  };
}

function fail(
  mode: CleanupMode,
  percent: number,
  error: CleanupErrorCode,
  extra?: { trashDir?: string },
): CleanupResult {
  return {
    ok: false,
    mode,
    percent,
    count: 0,
    bytes: 0,
    removedPaths: [],
    error,
    ...(extra?.trashDir ? { trashDir: extra.trashDir } : {}),
  };
}

/**
 * Execute archived cleanup bound to a preview digest.
 * Stages every physical file, writes the recovery manifest, then commits DB deletes.
 * Rollback never deletes a stage directory that still holds unrestored files.
 */
export function executeArchivedCleanup(options: ExecuteCleanupOptions): CleanupResult {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = clampPercent(options.percent);
  const busyTimeoutMs = options.busyTimeoutMs ?? 100;
  const failRollback = new Set(options._test?.failRollbackBasenames ?? []);
  const failPurge = new Set(options._test?.failPurgeBasenames ?? []);

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

  const paths = discoverRuntimeDbPaths(codexHome);
  const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
  if (!probe.ok) {
    return fail(mode, percent, probe.error);
  }

  // Preflight referenced-history / matching while DB is free, before any rename.
  const loaded = loadThreadsForCleanup(paths.state ?? "", preview.candidates, codexHome, busyTimeoutMs);
  if (!loaded.ok) {
    return fail(mode, percent, loaded.error);
  }

  const epoch = options.now ?? Date.now();
  const stageDir = join(codexHome, TRASH_DIR, String(epoch));
  const trashDir = trashRelPath(codexHome, stageDir);

  const stageResult = stageCandidates(codexHome, preview.candidates, stageDir);
  if (!stageResult.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  const threadByRelPath = new Map<string, ThreadSnapshot>();
  for (const thread of loaded.threads) {
    const normalized = normalizeArchivedRolloutPath(thread.rollout_path, codexHome);
    if (normalized) threadByRelPath.set(normalized, thread);
  }
  const manifestEntries: CleanupManifestEntry[] = preview.candidates.map(candidate => {
    const thread = threadByRelPath.get(candidate.relPath);
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

  // Manifest must exist before DB deletion so a mid-flight crash still has recovery metadata.
  try {
    if (options._test?.failManifestWrite) {
      throw new Error("test_fail_manifest_write");
    }
    writeFileSync(
      join(stageDir, "manifest.json"),
      JSON.stringify({
        quarantinedAt: epoch,
        mode,
        percent,
        digest: preview.digest,
        entries: manifestEntries,
      }, null, 2),
    );
  } catch {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  const deleted = reconcileDeletedThreads(
    paths,
    preview.candidates,
    codexHome,
    busyTimeoutMs,
    stageDir,
    options._test,
  );
  if (!deleted.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    // Keep the stage (and recovery manifest) when files or satellite DB rows remain unrestored.
    const keepTrash = Boolean(deleted.satelliteRestoreFailed) || !rolled.restored;
    if (!keepTrash) {
      removeStageIfEmpty(stageDir, rolled.remaining);
      removeEmptyTrashRoot(codexHome);
    }
    return fail(mode, percent, deleted.error, keepTrash ? { trashDir } : undefined);
  }

  const removedPaths = preview.candidates.map(c => c.relPath);
  const bytes = preview.candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (mode === "quarantine") {
    return {
      ok: true,
      mode,
      percent,
      count: removedPaths.length,
      bytes,
      trashDir,
      removedPaths,
    };
  }

  // Permanent: purge staged files only after a successful DB commit.
  const purge = purgeStaged(stageResult.staged, { failBasenames: failPurge });
  if (purge.remaining.length > 0) {
    // Overwrite the pre-commit manifest so recovery reflects what actually survived.
    const survivingRelPaths = new Set(purge.remaining.map(item => item.relPath));
    try {
      writeFileSync(
        join(stageDir, "manifest.json"),
        JSON.stringify({
          quarantinedAt: epoch,
          mode: "permanent",
          percent,
          digest: preview.digest,
          purgeIncomplete: true,
          purgedRelPaths: purge.purged.map(item => item.relPath),
          entries: manifestEntries.filter(entry =>
            entry.physicalRelPaths.some(rel => survivingRelPaths.has(rel)),
          ),
        }, null, 2),
      );
    } catch { /* best-effort: the pre-commit manifest is still on disk */ }
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      trashDir,
      removedPaths: [],
      error: "fs_failed",
    };
  }

  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* empty dir */ }
  // Drop an empty `.trash` root so permanent cleanup leaves no quarantine tree behind.
  removeEmptyTrashRoot(codexHome);

  return {
    ok: true,
    mode,
    percent,
    count: removedPaths.length,
    bytes,
    removedPaths,
  };
}
