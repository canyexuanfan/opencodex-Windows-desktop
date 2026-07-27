import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePreviewDigest,
  executeArchivedCleanup,
  listArchivedCandidates,
  normalizeArchivedRolloutPath,
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

function buildHome(opts?: { withSpawnEdges?: boolean; withDynamicTools?: boolean }): string {
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
    archived_at INTEGER,
    history_mode TEXT
  )`);
  db.exec(`INSERT INTO threads VALUES
    ('active','sessions/2026/05/27/rollout-active.jsonl',0,NULL,'legacy'),
    ('told','archived_sessions/rollout-old.jsonl',1,1,'legacy'),
    ('tmid','archived_sessions/rollout-mid.jsonl',1,2,'legacy'),
    ('tnew','archived_sessions/rollout-new.jsonl',1,3,'legacy')
  `);
  if (opts?.withSpawnEdges) {
    db.exec(`CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO thread_spawn_edges VALUES ('told','tmid','active')`);
  }
  if (opts?.withDynamicTools) {
    db.exec(`CREATE TABLE thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position),
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )`);
    db.exec(`INSERT INTO thread_dynamic_tools VALUES ('told',0,'tool','d','{}')`);
  }
  db.close();
  return dir;
}

function runWithDigest(
  percent: number,
  mode: "quarantine" | "permanent",
  codexHome: string,
  extra?: {
    busyTimeoutMs?: number;
    now?: number;
    digest?: string;
    _test?: {
      failManifestWrite?: boolean;
      failPurgeBasenames?: string[];
      failRollbackBasenames?: string[];
    };
  },
) {
  const preview = previewArchivedCleanup(percent, codexHome);
  return executeArchivedCleanup({
    percent,
    mode,
    digest: extra?.digest ?? preview.digest,
    codexHome,
    busyTimeoutMs: extra?.busyTimeoutMs,
    now: extra?.now,
    _test: extra?._test,
  });
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

  test("percent selects oldest subset and includes digest", () => {
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
    expect(preview.digest).toBe(computePreviewDigest(preview.candidates, 50));
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("treats .jsonl and .jsonl.zst as one logical rollout", () => {
    home = buildHome();
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "ZST");
    utimesSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), OLD, OLD);
    const listed = listArchivedCandidates(home);
    const old = listed.find(c => c.relPath === "archived_sessions/rollout-old.jsonl");
    expect(old).toBeTruthy();
    expect(old!.physicalRelPaths.sort()).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-old.jsonl.zst",
    ]);
    expect(listed.filter(c => c.relPath.includes("rollout-old"))).toHaveLength(1);
  });
});

describe("normalizeArchivedRolloutPath", () => {
  test("accepts exact archived paths and rejects active / basename-only matches", () => {
    home = buildHome();
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-old.jsonl", home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-old.jsonl.zst", home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath(join(home, "archived_sessions", "rollout-old.jsonl"), home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath("sessions/2026/05/27/rollout-active.jsonl", home)).toBeNull();
    expect(normalizeArchivedRolloutPath("rollout-old.jsonl", home)).toBeNull();
    // ISO timestamps in filenames must not be treated as Windows drive letters.
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-2026-01-01T10:00:00.jsonl", home))
      .toBe("archived_sessions/rollout-2026-01-01T10:00:00.jsonl");
  });
});

describe("executeArchivedCleanup", () => {
  test("quarantine moves files to .trash and removes matching threads", () => {
    home = buildHome();
    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_000 });
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
    const result = runWithDigest(100, "permanent", home);
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

  test("stale_preview when filesystem changed after preview", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(50, home);
    writeFileSync(join(home, "archived_sessions", "rollout-extra.jsonl"), "EXTRA");
    utimesSync(join(home, "archived_sessions", "rollout-extra.jsonl"), new Date("2025-01-01"), new Date("2025-01-01"));
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_preview");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("concurrent archiving that changes mtime/metadata yields stale_preview", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(50, home);
    const target = join(home, "archived_sessions", "rollout-old.jsonl");
    writeFileSync(target, "OLD".repeat(10) + "CHANGED");
    utimesSync(target, OLD, OLD);
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_preview");
  });

  test("does not delete active thread that shares basename with archived file", () => {
    home = buildHome();
    // Active row points at sessions/.../rollout-old.jsonl (same basename as archive).
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`INSERT INTO threads VALUES ('dupe','sessions/2026/05/27/rollout-old.jsonl',0,NULL,'legacy')`);
    writeFileSync(join(home, "sessions", "2026", "05", "27", "rollout-old.jsonl"), "ACTIVE-DUPE");
    db.close();

    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_001 });
    expect(result.ok).toBe(true);

    const check = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = check.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    check.close();
    expect(ids).toContain("dupe");
    expect(ids).not.toContain("told");
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-old.jsonl"))).toBe(true);
  });

  test("codex_busy probe skips all filesystem mutations", () => {
    home = buildHome();
    const locker = new Database(join(home, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    try {
      const result = runWithDigest(100, "quarantine", home, { busyTimeoutMs: 1 });
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

  test("rolls back staged renames when a later rename fails", () => {
    home = buildHome();
    const fresh = previewArchivedCleanup(100, home);
    expect(fresh.count).toBe(3);

    // Allow stageDir creation, then make the second candidate's destination a directory
    // so renameSync fails after the first file has already moved.
    mkdirSync(join(home, ".trash", "42"), { recursive: true });
    mkdirSync(join(home, ".trash", "42", "rollout-mid.jsonl"));

    const result = executeArchivedCleanup({
      percent: 100,
      mode: "quarantine",
      digest: fresh.digest,
      codexHome: home,
      now: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
  });

  test("rolls back staged renames when DB delete aborts after staging", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`CREATE TRIGGER deny_thread_delete BEFORE DELETE ON threads
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    db.close();
    const result = runWithDigest(50, "quarantine", home, { now: 77 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "77", "rollout-old.jsonl"))).toBe(false);
  });

  test("deletes spawn edges with parent_thread_id/child_thread_id and cascades dynamic tools", () => {
    home = buildHome({ withSpawnEdges: true, withDynamicTools: true });
    // Delete both sides of the edge together so referenced_history does not fire.
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM thread_spawn_edges").get() as { n: number }).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM thread_dynamic_tools").get() as { n: number }).toEqual({ n: 0 });
    db.close();
  });

  test("rejects candidates still referenced by a live spawn edge", () => {
    home = buildHome({ withSpawnEdges: true });
    // Edge told→tmid; deleting only oldest (told) leaves tmid outside the set.
    const result = runWithDigest(34, "quarantine", home);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("referenced_history");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("rejects paginated history_mode threads", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`UPDATE threads SET history_mode='paginated' WHERE id='told'`);
    db.close();
    const result = runWithDigest(50, "quarantine", home);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("referenced_history");
  });

  test("quarantine removes both plain and compressed physical files", () => {
    home = buildHome();
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "ZST");
    utimesSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), OLD, OLD);
    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_002 });
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"))).toBe(false);
    expect(existsSync(join(home, ".trash", "1700000000002", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "1700000000002", "rollout-old.jsonl.zst"))).toBe(true);
  });

  test("never returns ok with error field or absolute paths in error codes", () => {
    home = buildHome();
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: "deadbeef",
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_digest");
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("manifest-write failure rolls back staged files and leaves no stranded trash", () => {
    home = buildHome();
    const result = runWithDigest(50, "quarantine", home, {
      now: 88,
      _test: { failManifestWrite: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(result.trashDir).toBeUndefined();
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "88", "rollout-old.jsonl"))).toBe(false);
    // DB untouched
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    db.close();
    expect(ids).toContain("told");
  });

  test("rename-back failure keeps staged file and reports relative trashDir", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`CREATE TRIGGER deny_thread_delete BEFORE DELETE ON threads
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    db.close();

    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: previewArchivedCleanup(50, home).digest,
      codexHome: home,
      now: 91,
      _test: { failRollbackBasenames: ["rollout-old.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(result.trashDir).toBe(".trash/91");
    // Staged file must not be discarded when rename-back fails.
    expect(existsSync(join(home, ".trash", "91", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "91", "manifest.json"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("partial permanent purge preserves remaining stage and recovery path", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(100, home);
    const result = executeArchivedCleanup({
      percent: 100,
      mode: "permanent",
      digest: preview.digest,
      codexHome: home,
      now: 92,
      _test: { failPurgeBasenames: ["rollout-mid.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(result.trashDir).toBe(".trash/92");
    // Remaining staged file + manifest must survive for recovery.
    expect(existsSync(join(home, ".trash", "92", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "92", "manifest.json"))).toBe(true);
    // Successfully purged candidates are gone from archive and stage.
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".trash", "92", "rollout-old.jsonl"))).toBe(false);
    // DB rows for the batch are already committed away.
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active"]);
  });
});
