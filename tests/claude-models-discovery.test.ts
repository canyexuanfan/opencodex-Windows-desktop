import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-discovery-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-discovery-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function configWithStaticModels(claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        models: ["test-model", "other-model"],
      },
    },
    ...(claudeCode ? { claudeCode } : {}),
  } as OcxConfig;
}

test("anthropic-version header flips /v1/models to the discovery contract", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?limit=1000", server.url), {
      headers: { "anthropic-version": "2023-06-01", "authorization": "Bearer placeholder" },
    });
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { id: string; display_name?: string }[] };
    expect(Array.isArray(json.data)).toBe(true);
    const routed = json.data.filter(m => m.id.includes("--mock--") || m.id.includes("mock--"));
    const ids = json.data.map(m => m.id);
    expect(ids).toContain("claude-ocx-mock--test-model");
    // Every entry must satisfy the picker prefix rule (003 G3).
    for (const entry of json.data) {
      expect(entry.id.startsWith("claude") || entry.id.startsWith("anthropic")).toBe(true);
      expect(typeof entry.display_name).toBe("string");
    }
    expect(routed.find(m => m.id === "claude-ocx-mock--test-model")?.display_name).toBe("test-model (mock)");
    // Contract shape only: no OpenAI list fields on the top level.
    expect((json as Record<string, unknown>).object).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("?flavor=anthropic works without the header; disabled -> empty data", async () => {
  saveConfig(configWithStaticModels());
  let server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: { id: string }[] };
    expect(json.data.some(m => m.id === "claude-ocx-mock--other-model")).toBe(true);
  } finally {
    server.stop(true);
  }

  saveConfig(configWithStaticModels({ enabled: false }));
  server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: unknown[] };
    expect(json.data).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("OpenAI list shape and Codex catalog shape stay unchanged", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url));
    const plainJson = await plain.json() as { object: string; data: { id: string; object: string }[] };
    expect(plainJson.object).toBe("list");
    expect(plainJson.data.some(m => m.id === "mock/test-model")).toBe(true);
    for (const m of plainJson.data) expect(m.object).toBe("model");

    const codex = await fetch(new URL("/v1/models?client_version=1.0.0", server.url), {
      // A Codex client that happens to send an anthropic-version header must still get the catalog.
      headers: { "anthropic-version": "2023-06-01" },
    });
    const codexJson = await codex.json() as { models?: unknown[]; data?: unknown };
    expect(Array.isArray(codexJson.models)).toBe(true);
    expect(codexJson.data).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
