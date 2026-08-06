import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-profile-editor-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1", "m2"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    routingProfiles: {
      fast: {
        alias: "ocx/fast",
        candidates: [{ provider: "a", model: "m1" }],
      },
    },
  };
}

function deps(onSave: () => void = () => {}, onRefresh: () => void = () => {}) {
  return {
    saveConfigPreservingClaudeCode: () => onSave(),
    createManagementConvergeCodex: () => async () => {
      onRefresh();
      return {
        kind: "catalog-only" as const,
        catalogRefresh: {
          status: "committed" as const,
          changed: false,
          degraded: false,
          notices: [],
        },
      };
    },
  };
}

describe("routing profile management editor API", () => {
  test("GET exposes the configured alias for editor round-trips", async () => {
    const config = baseConfig();
    const req = new ManagementRequest("http://localhost/api/routing-profiles", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config, deps());
    expect(response?.status).toBe(200);
    const body = await response!.json() as { profiles?: Array<{ id?: string; alias?: string | null }> };
    expect(body.profiles?.[0]).toMatchObject({ id: "fast", alias: "ocx/fast" });
  });

  test("PUT creates a validated normalized profile and refreshes the catalog", async () => {
    const config = baseConfig();
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "balanced",
        profile: {
          alias: "ocx/balanced",
          candidates: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          require: { tools: false, minContextWindow: 64000 },
          optimize: { latency: 2, health: 1, cost: 1, quota: 0 },
          limits: { maxEstimatedCostUsd: 0.25 },
          unknownEvidence: {
            capability: "exclude",
            health: "penalize",
            quota: "allow",
            cost: "penalize",
          },
        },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(200);
    const body = await response!.json() as {
      success?: boolean;
      profile?: { alias?: string | null; optimize?: Record<string, number>; revision?: string };
    };
    expect(body.success).toBe(true);
    expect(body.profile?.alias).toBe("ocx/balanced");
    expect(body.profile?.optimize).toEqual({ latency: 0.5, health: 0.25, cost: 0.25, quota: 0 });
    expect(body.profile?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(config.routingProfiles?.balanced).toMatchObject({
      alias: "ocx/balanced",
      require: { tools: false, minContextWindow: 64000 },
    });
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("PUT rejects invalid candidates without mutating or persisting", async () => {
    const config = baseConfig();
    let saves = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "broken",
        profile: { candidates: [{ provider: "missing", model: "m1" }] },
      }),
    });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }),
    );

    expect(response?.status).toBe(400);
    const body = await response!.json() as { error?: { code?: string; issues?: unknown[] } };
    expect(body.error?.code).toBe("invalid_profile");
    expect(body.error?.issues?.length).toBeGreaterThan(0);
    expect(config.routingProfiles).not.toHaveProperty("broken");
    expect(saves).toBe(0);
  });

  test("DELETE removes a profile, persists, and refreshes the catalog", async () => {
    const config = baseConfig();
    let saves = 0;
    let refreshes = 0;
    const req = new ManagementRequest("http://localhost/api/routing-profiles?id=fast", { method: "DELETE" });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config,
      deps(() => { saves += 1; }, () => { refreshes += 1; }),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ success: true, id: "fast" });
    expect(config.routingProfiles).toBeUndefined();
    expect(saves).toBe(1);
    expect(refreshes).toBe(1);
  });
});
