import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function seedArchived(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), "o".repeat(100));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), "n".repeat(200));
  utimesSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), new Date("2026-06-01"), new Date("2026-06-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES
    ('told','archived_sessions/rollout-old.jsonl',1),
    ('tnew','archived_sessions/rollout-new.jsonl',1)
  `);
  db.close();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-storage-cleanup-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-storage-cleanup-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("POST /api/storage/cleanup", () => {
  test("preview returns digest without host paths", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.candidates[0].relPath).toBe("archived_sessions/rollout-old.jsonl");
      expect(body.candidates[0].absPath).toBeUndefined();
      expect(body.codexHome).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("quarantine mode moves files and returns trashDir", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("quarantine");
      expect(body.count).toBe(1);
      expect(body.trashDir).toContain(".trash/");
      expect(body.error).toBeUndefined();
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("permanent mode deletes files without trash", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "permanent", digest: preview.digest }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("permanent");
      expect(body.count).toBe(1);
      expect(body.trashDir).toBeUndefined();
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(isolatedCodexHome!.path, ".trash"))).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("stale_preview returns 409 with mapped error only", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      writeFileSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-extra.jsonl"), "x");
      utimesSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-extra.jsonl"), new Date("2025-01-01"), new Date("2025-01-01"));
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("stale_preview");
      expect(JSON.stringify(body)).not.toContain(isolatedCodexHome!.path);
    } finally {
      await server.stop(true);
    }
  });

  test("codex_busy returns 409", async () => {
    seedArchived(isolatedCodexHome!.path);
    const locker = new Database(join(isolatedCodexHome!.path, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("codex_busy");
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  test("rejects invalid mode", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 10, mode: "yeet", digest: "a".repeat(64) }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_mode");
    } finally {
      await server.stop(true);
    }
  });
});
