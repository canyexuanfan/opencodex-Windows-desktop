import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { CODEX_HOME } from "./codex-paths";
import { atomicWriteFile, getConfigDir } from "./config";

const STATE_DB_PATH = join(CODEX_HOME, "state_5.sqlite");
function historyBackupPathFor(stateDbPath: string): string {
  const normalized = process.platform === "win32" ? resolve(stateDbPath).toLowerCase() : resolve(stateDbPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `codex-history-backup-${id}.json`);
}
const HISTORY_BACKUP_PATH = historyBackupPathFor(STATE_DB_PATH);
const RESUMABLE_SOURCES = ["cli", "vscode"] as const;

/**
 * Open the live `state_5.sqlite` the way the Codex app expects a *secondary* writer to behave:
 * wait on the WAL/file lock instead of failing instantly, so we never race the app's own
 * connection pool into a half-applied checkpoint. The app opens this DB with `busy_timeout=5s`
 * (see codex-rs `state::runtime::base_sqlite_options`); we mirror that here.
 */
function openStateDb(stateDbPath: string): Database {
  const db = new Database(stateDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* best-effort: an older sqlite without busy_timeout still works, just less politely */
  }
  return db;
}

/**
 * Rewrite the first line of a rollout JSONL *in place*, preserving the file's inode.
 *
 * The Codex app keeps a cached append-mode file handle for the live session's rollout
 * (codex-rs `RolloutWriterState::ensure_writer_open` only reopens when the handle is gone). If we
 * replaced the file via temp+rename (`atomicWriteFile`), the app would keep writing to the now
 * orphaned inode while the path holds only our snapshot — so the live session's new turns would
 * silently vanish on the next app restart. Writing in place keeps the app's handle valid.
 */
function rewriteFirstLineInPlace(path: string, newContent: string): void {
  const stat = statSync(path);
  const fd = openSync(path, "r+");
  try {
    const buf = Buffer.from(newContent, "utf8");
    writeSync(fd, buf, 0, buf.length, 0);
    ftruncateSync(fd, buf.length);
  } finally {
    closeSync(fd);
  }
  // Preserve timestamps so the app's mtime-based backfill watermark isn't perturbed.
  utimesSync(path, stat.atime, stat.mtime);
}

type CodexHistoryProvider = "openai" | "opencodex";

export interface CodexHistorySyncResult {
  rows: number;
  files: number;
  ejectedRows?: number;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  model_provider: string;
  source: string;
  has_user_event: number;
}

interface BackupEntry {
  id: string;
  rolloutPath: string;
  modelProvider: string;
  source: string;
  hasUserEvent: number;
}

interface BackupManifest {
  version: 1;
  stateDbPath?: string;
  entries: Record<string, BackupEntry>;
}

interface NativeRestoreTarget {
  modelProvider: string;
  source: string;
  hasUserEvent: number;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function readBackup(path: string, stateDbPath?: string): BackupManifest {
  if (!existsSync(path)) return { version: 1, stateDbPath, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, stateDbPath, entries: {} };
    }
    if (stateDbPath && typeof parsed.stateDbPath === "string" && !samePath(parsed.stateDbPath, stateDbPath)) {
      return { version: 1, stateDbPath, entries: {} };
    }
    return { version: 1, stateDbPath: parsed.stateDbPath ?? stateDbPath, entries: parsed.entries };
  } catch {
    return { version: 1, stateDbPath, entries: {} };
  }
}

function writeBackup(path: string, manifest: BackupManifest, stateDbPath?: string): void {
  if (Object.keys(manifest.entries).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify({ ...manifest, stateDbPath: manifest.stateDbPath ?? stateDbPath }, null, 2) + "\n");
}

function rememberOriginal(manifest: BackupManifest, row: ThreadRow): void {
  if (manifest.entries[row.id]) return;
  manifest.entries[row.id] = {
    id: row.id,
    rolloutPath: row.rollout_path,
    modelProvider: row.model_provider,
    source: row.source,
    hasUserEvent: Number(row.has_user_event) || 0,
  };
}

function updateSessionMeta(path: string, patch: { provider?: string; source?: string }): boolean {
  if (!path || !existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  const newline = raw.indexOf("\n");
  const firstLine = newline === -1 ? raw : raw.slice(0, newline);
  const rest = newline === -1 ? "" : raw.slice(newline);

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as { type?: unknown; payload?: { model_provider?: unknown; source?: unknown } };
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return false;

  let changed = false;
  if (patch.provider !== undefined && record.payload.model_provider !== patch.provider) {
    record.payload.model_provider = patch.provider;
    changed = true;
  }
  if (patch.source !== undefined && record.payload.source !== patch.source) {
    record.payload.source = patch.source;
    changed = true;
  }
  if (!changed) return false;

  // In-place rewrite (NOT temp+rename): the Codex app caches the live session's rollout file
  // handle, so swapping the inode would orphan its writer and drop new turns. See
  // rewriteFirstLineInPlace for the full rationale.
  rewriteFirstLineInPlace(path, `${JSON.stringify(record)}${rest}`);
  return true;
}

function toNativeRestoreTarget(entry: BackupEntry): NativeRestoreTarget {
  if (entry.modelProvider !== "opencodex") {
    return {
      modelProvider: entry.modelProvider,
      source: entry.source,
      hasUserEvent: entry.hasUserEvent,
    };
  }
  return {
    modelProvider: "openai",
    source: entry.source === "exec" ? "cli" : entry.source,
    hasUserEvent: 1,
  };
}

function ejectRemainingOpencodexHistory(db: Database): { rows: number; files: number } {
  const rows = db
    .query<ThreadRow, []>(`
      SELECT id, rollout_path, model_provider, source, has_user_event
      FROM threads
      WHERE model_provider = 'opencodex'
        AND trim(coalesce(first_user_message, '')) != ''
    `)
    .all();

  let files = 0;
  for (const row of rows) {
    try {
      if (updateSessionMeta(row.rollout_path, {
        provider: "openai",
        source: row.source === "exec" ? "cli" : undefined,
      })) files++;
    } catch {
      /* native restore should continue even if an old rollout is missing */
    }
  }

  const restore = db.transaction(() => {
    const update = db.query(`
      UPDATE threads
      SET model_provider = 'openai',
          source = CASE WHEN source = 'exec' THEN 'cli' ELSE source END,
          has_user_event = 1
      WHERE id = ?
    `);
    for (const row of rows) update.run(row.id);
  });
  restore();
  return { rows: rows.length, files };
}

function isRecoverableHistoryError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || code === "EBUSY"
    || code === "EPERM"
    || code === "EACCES"
    || message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("resource busy")
    || message.includes("operation not permitted")
    || message.includes("permission denied");
}

export function syncCodexHistoryProvider(provider: CodexHistoryProvider, stateDbPath = STATE_DB_PATH, backupPath = HISTORY_BACKUP_PATH): CodexHistorySyncResult {
  try {
    return syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath);
  } catch (error) {
    if (isRecoverableHistoryError(error)) return { rows: 0, files: 0 };
    throw error;
  }
}

function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  if (provider === "openai") return restoreCodexHistoryProvider(stateDbPath, backupPath);

  const db = openStateDb(stateDbPath);
  try {
    const placeholders = RESUMABLE_SOURCES.map(() => "?").join(",");
    const openaiRows = db
      .query<ThreadRow, string[]>(`
        SELECT id, rollout_path, model_provider, source, has_user_event
        FROM threads
        WHERE model_provider = 'openai'
          AND source IN (${placeholders})
      `)
      .all(...RESUMABLE_SOURCES);
    const execRows = db
      .query<ThreadRow, []>(`
        SELECT id, rollout_path, model_provider, source, has_user_event
        FROM threads
        WHERE model_provider = 'opencodex'
          AND source = 'exec'
          AND trim(coalesce(first_user_message, '')) != ''
      `)
      .all();

    const manifest = readBackup(backupPath, stateDbPath);
    for (const row of [...openaiRows, ...execRows]) rememberOriginal(manifest, row);
    writeBackup(backupPath, manifest, stateDbPath);

    let files = 0;
    for (const row of openaiRows) {
      try {
        if (updateSessionMeta(row.rollout_path, { provider: "opencodex" })) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }
    for (const row of execRows) {
      try {
        if (updateSessionMeta(row.rollout_path, { source: "cli" })) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }

    const update = db.transaction(() => {
      const markUserEvent = db.query(`
        UPDATE threads
        SET has_user_event = 1
        WHERE id = ?
          AND trim(coalesce(first_user_message, '')) != ''
      `);
      for (const row of [...openaiRows, ...execRows]) markUserEvent.run(row.id);
      db.query(`
        UPDATE threads
        SET model_provider = 'opencodex'
        WHERE model_provider = 'openai'
          AND source IN (${placeholders})
      `).run(...RESUMABLE_SOURCES);
      db.query(`
        UPDATE threads
        SET source = 'cli'
        WHERE model_provider = 'opencodex'
          AND source = 'exec'
          AND trim(coalesce(first_user_message, '')) != ''
      `).run();
    });
    update();

    return { rows: openaiRows.length + execRows.length, files };
  } finally {
    db.close();
  }
}

function restoreCodexHistoryProvider(stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  const manifest = readBackup(backupPath, stateDbPath);
  const entries = Object.values(manifest.entries);

  const db = openStateDb(stateDbPath);
  try {
    if (entries.length === 0) {
      const ejected = ejectRemainingOpencodexHistory(db);
      return ejected.rows > 0 ? { rows: 0, files: ejected.files, ejectedRows: ejected.rows } : { rows: 0, files: 0 };
    }

    let files = 0;
    for (const entry of entries) {
      const target = toNativeRestoreTarget(entry);
      try {
        if (updateSessionMeta(entry.rolloutPath, { provider: target.modelProvider, source: target.source })) files++;
      } catch {
        /* best-effort; keep DB restore moving even if one rollout disappeared */
      }
    }

    const restore = db.transaction(() => {
      const update = db.query(`
        UPDATE threads
        SET model_provider = ?,
            source = ?,
            has_user_event = ?
        WHERE id = ?
      `);
      for (const entry of entries) {
        const target = toNativeRestoreTarget(entry);
        update.run(target.modelProvider, target.source, target.hasUserEvent, entry.id);
      }
    });
    restore();
    writeBackup(backupPath, { version: 1, stateDbPath, entries: {} }, stateDbPath);
    const ejected = ejectRemainingOpencodexHistory(db);
    return ejected.rows > 0
      ? { rows: entries.length, files: files + ejected.files, ejectedRows: ejected.rows }
      : { rows: entries.length, files };
  } finally {
    db.close();
  }
}

export function restoreLegacyOpenaiHistory(stateDbPath = STATE_DB_PATH): { rows: number; files: number } {
  try {
    if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
    const db = openStateDb(stateDbPath);
    try {
      return ejectRemainingOpencodexHistory(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (isRecoverableHistoryError(error)) return { rows: 0, files: 0 };
    throw error;
  }
}
