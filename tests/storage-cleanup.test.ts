import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeArchivedCleanup,
  listArchivedCandidates,
  previewArchivedCleanup,
  selectOldestPercent,
} from "../src/storage/cleanup";

const OLD = new Date("2026-01-01T00:00:00Z");
const MID = new Date("2026-02-01T00:00:00Z");
const NEW = new Date("2026-03-01T00:00:00Z");

let home = "";

afterEach(() => {
  if (home) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    home = "";
  }
});

function buildHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cleanup-"));
  mkdirSync(join(dir, "sessions", "2026", "05", "27"), { recursive: true });
  writeFileSync(join(dir, "sessions", "2026", "05", "27", "rollout-active.jsonl"), "ACTIVE".repeat(20));

  mkdirSync(join(dir, "archived_sessions"));
  writeFileSync(join(dir, "archived_sessions", "rollout-old.jsonl"), "OLD".repeat(10));
  writeFileSync(join(dir, "archived_sessions", "rollout-mid.jsonl"), "MID".repeat(20));
  writeFileSync(join(dir, "archived_sessions", "rollout-new.jsonl"), "NEW".repeat(30));
  utimesSync(join(dir, "archived_sessions", "rollout-old.jsonl"), OLD, OLD);
  utimesSync(join(dir, "archived_sessions", "rollout-mid.jsonl"), MID, MID);
  utimesSync(join(dir, "archived_sessions", "rollout-new.jsonl"), NEW, NEW);

  const db = new Database(join(dir, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    archived INTEGER,
    archived_at INTEGER
  )`);
  db.exec(`INSERT INTO threads VALUES
    ('active','sessions/2026/05/27/rollout-active.jsonl',0,NULL),
    ('told','archived_sessions/rollout-old.jsonl',1,1),
    ('tmid','archived_sessions/rollout-mid.jsonl',1,2),
    ('tnew','archived_sessions/rollout-new.jsonl',1,3)
  `);
  db.close();
  return dir;
}

describe("previewArchivedCleanup", () => {
  test("lists archived files oldest-first and ignores active sessions", () => {
    home = buildHome();
    const listed = listArchivedCandidates(home);
    expect(listed.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
    expect(listed.some(c => c.relPath.includes("sessions/2026"))).toBe(false);
  });

  test("percent selects oldest subset", () => {
    home = buildHome();
    const all = listArchivedCandidates(home);
    expect(selectOldestPercent(all, 0)).toEqual([]);
    expect(selectOldestPercent(all, 34).map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
    ]);
    expect(selectOldestPercent(all, 100)).toHaveLength(3);
    const preview = previewArchivedCleanup(50, home);
    expect(preview.count).toBe(1);
    expect(preview.candidates[0]!.relPath).toBe("archived_sessions/rollout-old.jsonl");
    expect(preview.bytes).toBe(preview.candidates[0]!.bytes);
  });
});

describe("executeArchivedCleanup", () => {
  test("quarantine moves files to .trash and removes matching threads", () => {
    home = buildHome();
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      codexHome: home,
      now: 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.removedPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-active.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    const trashFile = join(home, ".trash", "1700000000000", "rollout-old.jsonl");
    expect(existsSync(trashFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(home, ".trash", "1700000000000", "manifest.json"), "utf8"));
    expect(manifest.entries[0].threadId).toBe("told");

    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active", "tmid", "tnew"]);
  });

  test("permanent deletes files and threads without creating trash", () => {
    home = buildHome();
    const result = executeArchivedCleanup({ percent: 100, mode: "permanent", codexHome: home });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".trash"))).toBe(false);
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-active.jsonl"))).toBe(true);

    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active"]);
  });

  test("codex_busy probe skips all filesystem mutations", () => {
    home = buildHome();
    const locker = new Database(join(home, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    try {
      const result = executeArchivedCleanup({
        percent: 100,
        mode: "quarantine",
        codexHome: home,
        busyTimeoutMs: 1,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("codex_busy");
      expect(result.count).toBe(0);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, ".trash"))).toBe(false);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });
});
