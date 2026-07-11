import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-mgmt-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-mgmt-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

test("GET /api/claude-code returns defaults + available + aliases", async () => {
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.enabled).toBe(true);
    expect(d.model).toBe("");
    expect(d.smallFastModel).toBe("");
    expect(d.modelMap).toEqual({});
    expect(d.available).toContain("mock/test-model");
    const { desktop3pAlias } = await import("../src/claude/desktop-3p");
    expect(d.aliases.some((a: { id: string }) => a.id === desktop3pAlias("mock", "test-model"))).toBe(true);
    expect(typeof d.port).toBe("number");
  } finally {
    server.stop(true);
  }
});

test("PUT round-trips settings and persists to config", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        model: "mock/test-model",
        smallFastModel: " mock/test-model ",
        modelMap: { "claude-sonnet-4-5": "mock/test-model" },
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, enabled: false });

    const persisted = loadConfig();
    expect(persisted.claudeCode).toEqual({
      enabled: false,
      model: "mock/test-model",
      smallFastModel: "mock/test-model",
      modelMap: { "claude-sonnet-4-5": "mock/test-model" },
    });

    // Clearing a slot with "" deletes it; partial PUT leaves other fields alone.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(clear.status).toBe(200);
    const after = loadConfig();
    expect(after.claudeCode?.model).toBeUndefined();
    expect(after.claudeCode?.smallFastModel).toBe("mock/test-model");
    expect(after.claudeCode?.enabled).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("PUT/GET round-trips the context/effort levers (devlog 136 B6)", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxContextTokens: 1_000_000, alwaysEnableEffort: true }),
    });
    expect(put.status).toBe(200);
    let persisted = loadConfig();
    expect(persisted.claudeCode?.maxContextTokens).toBe(1_000_000);
    expect(persisted.claudeCode?.alwaysEnableEffort).toBe(true);

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.maxContextTokens).toBe(1_000_000);
    expect(get.alwaysEnableEffort).toBe(true);

    // null clears the context override; alwaysEnableEffort:false deletes the flag.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxContextTokens: null, alwaysEnableEffort: false }),
    });
    expect(clear.status).toBe(200);
    persisted = loadConfig();
    expect(persisted.claudeCode?.maxContextTokens).toBeUndefined();
    expect(persisted.claudeCode?.alwaysEnableEffort).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("PUT/GET round-trips tierModels and GET exposes contextWindows + effectiveModelEnv (devlog 260712 B2)", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: "mock/test-model", haiku: " mock/other-model " } }),
    });
    expect(put.status).toBe(200);
    const persisted = loadConfig();
    expect(persisted.claudeCode?.tierModels).toEqual({ opus: "mock/test-model", haiku: "mock/other-model" });

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, any>;
    expect(get.tierModels).toEqual({ opus: "mock/test-model", haiku: "mock/other-model" });
    expect(typeof get.contextWindows).toBe("object");
    expect(get.effectiveModelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("mock/test-model");
    expect(get.effectiveModelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/other-model");
    expect(get.effectiveModelEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/other-model");

    // Clearing with empty strings deletes the block; bad shapes 400.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: "", haiku: "" } }),
    });
    expect(clear.status).toBe(200);
    expect(loadConfig().claudeCode?.tierModels).toBeUndefined();
    const bad = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: 5 } }),
    });
    expect(bad.status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("PUT validation rejects bad shapes", async () => {
  const server = startServer(0);
  try {
    const cases: [Record<string, unknown>, string][] = [
      [{ enabled: "yes" }, "enabled must be a boolean"],
      [{ model: 5 }, "model must be a string"],
      [{ maxContextTokens: 0 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: -1 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: 1.5 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: "1000000" }, "maxContextTokens must be a positive integer or null"],
      [{ alwaysEnableEffort: "on" }, "alwaysEnableEffort must be a boolean"],
      [{ modelMap: ["a"] }, "modelMap must be an object of string->string"],
      [{ modelMap: { "": "x" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: "" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: 3 } }, "modelMap entries must be non-empty strings"],
    ];
    for (const [body, error] of cases) {
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
    expect(loadConfig().claudeCode).toBeUndefined(); // nothing persisted on rejects
  } finally {
    server.stop(true);
  }
});
