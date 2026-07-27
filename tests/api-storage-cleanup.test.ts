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
  test("preview returns oldest percent without mutating", async () => {
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
      expect(body.candidates[0].relPath).toBe("archived_sessions/rollout-old.jsonl");
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("quarantine mode moves files and returns trashDir", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("quarantine");
      expect(body.count).toBe(1);
      expect(body.trashDir).toContain(".trash/");
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects invalid mode", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 10, mode: "yeet" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});
