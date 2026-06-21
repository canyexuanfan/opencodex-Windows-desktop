import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { syncCodexHistoryProvider } from "../src/codex-history-provider";

function makeFixture() {
  const dir = join(tmpdir(), `ocx-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const rollout = join(dir, "rollout.jsonl");
  writeFileSync(rollout, [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", model_provider: "openai", cwd: dir },
    }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { message: "x" } }),
  ].join("\n") + "\n");
  const mtime = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(rollout, mtime, mtime);

  const dbPath = join(dir, "state_5.sqlite");
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    INSERT INTO threads (id, rollout_path, model_provider, source, first_user_message, has_user_event)
    VALUES ('thread-1', ?, 'openai', 'vscode', 'hello', 0)
  `, rollout);
  db.close();
  return { dbPath, rollout, mtime };
}

describe("Codex history provider sync", () => {
  test("maps resumable Codex threads to opencodex without touching file mtime", () => {
    const { dbPath, rollout, mtime } = makeFixture();

    const result = syncCodexHistoryProvider("opencodex", dbPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "opencodex" });
    expect(db.query("SELECT has_user_event FROM threads WHERE id = 'thread-1'").get()).toEqual({ has_user_event: 1 });
    db.close();
    const firstLine = readFileSync(rollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("opencodex");
    expect(statSync(rollout).mtime.getTime()).toBe(mtime.getTime());
  });

  test("maps resumable Codex threads back to openai", () => {
    const { dbPath, rollout } = makeFixture();
    syncCodexHistoryProvider("opencodex", dbPath);

    const result = syncCodexHistoryProvider("openai", dbPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
    const firstLine = readFileSync(rollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
  });
});
