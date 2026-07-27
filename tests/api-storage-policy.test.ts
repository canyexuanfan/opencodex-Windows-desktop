import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";

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
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-storage-policy-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-storage-policy-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  stopStorageCleanupScheduler();
});

afterEach(() => {
  stopStorageCleanupScheduler();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("storage cleanup policy API", () => {
  test("GET returns default-off policy without enabling", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.mode).toBe("quarantine");
      expect(body.schedule).toBe("manual");
      expect(body.trigger.archivedBytesOver).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
      stopStorageCleanupScheduler();
    }
  });

  test("PUT persists policy and never enables when enabled omitted", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger: { archivedBytesOver: 1024 },
          target: { removeOldestPercent: 40 },
          schedule: "daily",
          mode: "quarantine",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.policy.enabled).toBe(false);
      expect(body.policy.trigger.archivedBytesOver).toBe(1024);
      expect(body.policy.target.removeOldestPercent).toBe(40);
      expect(body.policy.schedule).toBe("daily");

      const get = await fetch(new URL("/api/storage/cleanup-policy", server.url));
      const again = await get.json();
      expect(again.enabled).toBe(false);
      expect(again.trigger.archivedBytesOver).toBe(1024);
    } finally {
      await server.stop(true);
      stopStorageCleanupScheduler();
    }
  });

  test("PUT rejects invalid target", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          target: { reduceToBytes: 1, removeOldestPercent: 10 },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("target");
    } finally {
      await server.stop(true);
      stopStorageCleanupScheduler();
    }
  });

  test("POST run skips when disabled; runs when enabled", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const skipped = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
        method: "POST",
      });
      expect(skipped.status).toBe(200);
      const skipBody = await skipped.json();
      expect(skipBody.skipped).toBe("disabled");

      await fetch(new URL("/api/storage/cleanup-policy", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          trigger: { archivedBytesOver: 50 },
          target: { removeOldestPercent: 50 },
          schedule: "manual",
          mode: "quarantine",
        }),
      });

      const ran = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
        method: "POST",
      });
      expect(ran.status).toBe(200);
      const ranBody = await ran.json();
      expect(ranBody.ok).toBe(true);
      expect(ranBody.removed).toBe(1);
      expect(ranBody.freedBytes).toBe(100);
      expect(ranBody.policy.lastRun.removed).toBe(1);
      expect(JSON.stringify(ranBody)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
    } finally {
      await server.stop(true);
      stopStorageCleanupScheduler();
    }
  });
});
