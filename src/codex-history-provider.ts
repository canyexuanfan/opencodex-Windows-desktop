import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CODEX_HOME } from "./codex-paths";

const STATE_DB_PATH = join(CODEX_HOME, "state_5.sqlite");
const RESUMABLE_SOURCES = ["cli", "vscode"] as const;

type CodexHistoryProvider = "openai" | "opencodex";

interface ThreadRow {
  id: string;
  rollout_path: string;
}

function updateSessionMetaProvider(path: string, provider: CodexHistoryProvider): boolean {
  if (!path || !existsSync(path)) return false;
  const stat = statSync(path);
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
  const record = parsed as { type?: unknown; payload?: { model_provider?: unknown } };
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return false;
  if (record.payload.model_provider === provider) return false;

  record.payload.model_provider = provider;
  writeFileSync(path, `${JSON.stringify(record)}${rest}`, "utf8");
  utimesSync(path, stat.atime, stat.mtime);
  return true;
}

export function syncCodexHistoryProvider(provider: CodexHistoryProvider, stateDbPath = STATE_DB_PATH): { rows: number; files: number } {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  const from = provider === "opencodex" ? "openai" : "opencodex";
  const db = new Database(stateDbPath);
  try {
    const placeholders = RESUMABLE_SOURCES.map(() => "?").join(",");
    const rows = db
      .query<ThreadRow, string[]>(`
        SELECT id, rollout_path
        FROM threads
        WHERE model_provider = ?
          AND source IN (${placeholders})
      `)
      .all(from, ...RESUMABLE_SOURCES);

    let files = 0;
    for (const row of rows) {
      try {
        if (updateSessionMetaProvider(row.rollout_path, provider)) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }

    const update = db.transaction(() => {
      db.query(`
        UPDATE threads
        SET has_user_event = 1
        WHERE source IN (${placeholders})
          AND trim(coalesce(first_user_message, '')) != ''
      `).run(...RESUMABLE_SOURCES);
      db.query(`
        UPDATE threads
        SET model_provider = ?
        WHERE model_provider = ?
          AND source IN (${placeholders})
      `).run(provider, from, ...RESUMABLE_SOURCES);
    });
    update();

    return { rows: rows.length, files };
  } finally {
    db.close();
  }
}
