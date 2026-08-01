import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function effortConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: {
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://kimi.test/v1",
        models: ["k3", "kimi-for-coding"],
        modelReasoningEfforts: {
          k3: ["low", "high", "max"],
          "kimi-for-coding": [],
        },
        modelDefaultReasoningEfforts: { k3: "high" },
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-grok-effort-list-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("raw /v1/models list reasoning-effort advertisement (Grok Build discovery)", () => {
  test("routed models with configured tiers advertise the Grok reasoning catalog shape", async () => {
    saveConfig(effortConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3).toBeDefined();
      expect(k3!.supports_reasoning_effort).toBe(true);
      expect(k3!.reasoning_effort).toBe("high");
      expect(k3!.reasoning_efforts).toEqual([
        { value: "low", label: "Low Effort" },
        { value: "high", label: "High Effort", default: true },
        { value: "max", label: "Max Effort" },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("models with an empty tier list advertise no effort fields", async () => {
    saveConfig(effortConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const plain = body.data.find(m => m.id === "kimi/kimi-for-coding");
      expect(plain).toBeDefined();
      expect("supports_reasoning_effort" in plain!).toBe(false);
      expect("reasoning_effort" in plain!).toBe(false);
      expect("reasoning_efforts" in plain!).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid configured default falls back to the first tier", async () => {
    const config = effortConfig();
    config.providers.kimi!.modelDefaultReasoningEfforts = { k3: "medium" };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3!.reasoning_effort).toBe("low");
      const options = k3!.reasoning_efforts as Array<Record<string, unknown>>;
      expect(options[0]).toEqual({ value: "low", label: "Low Effort", default: true });
    } finally {
      await server.stop(true);
    }
  });
});
