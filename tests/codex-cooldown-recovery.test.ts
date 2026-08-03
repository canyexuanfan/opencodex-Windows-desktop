import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  clearCodexCooldownRecoveryProbeState,
  clearAccountQuota,
  runCodexCooldownRecoveryProbes,
  seedCodexAuthAdmissionForTests,
} from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-cooldown-recovery-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const START = 1_800_000_000_000;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

function makeConfig(ids = ["a", "b"]): OcxConfig {
  return {
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: ids[0],
    accountPoolStrategy: "fill-first",
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, plan: "team", isMain: false })),
  } as OcxConfig;
}

function saveCredential(id: string, suffix = ""): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}${suffix}`,
    refreshToken: `refresh-${id}${suffix}`,
    expiresAt: Date.now() + 60 * 60_000,
    chatgptAccountId: `acct-${id}${suffix}`,
  });
}

function cool(config: OcxConfig, id: string, scope: "shared" | "spark" = "shared", now = START): void {
  recordCodexUpstreamOutcome(config, id, 429, {
    now,
    resetAt: now + 60 * 60_000,
    modelId: scope === "spark" ? "gpt-5.3-codex-spark" : "gpt-5.6-sol",
  });
}

function usageResponse(percent = 10, body?: unknown): Response {
  return new Response(JSON.stringify(body ?? {
    plan_type: "team",
    rate_limit: { secondary_window: { used_percent: percent, reset_at: 1_900_000_000 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function due(at = START): number {
  return at + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
}

describe("Codex cooldown recovery worker", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    previousFetch = globalThis.fetch;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("recovers cooled A independently while ordinary routing only selects B", async () => {
    const config = makeConfig();
    saveCredential("a");
    saveCredential("b");
    cool(config, "a");
    const routed = [resolveCodexAccountForThread("before", config, due())];
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return usageResponse(12);
    };

    await runCodexCooldownRecoveryProbes(config, due());
    routed.push(resolveCodexAccountForThread("after", config, due() + 1));

    expect(authorizations).toEqual(["Bearer access-a"]);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).toBeNull();
    expect(routed).toEqual(["b", "b"]);
  });

  test.each([
    ["still exhausted", () => usageResponse(100)],
    ["credits only", () => usageResponse(0, { plan_type: "team", rate_limit_reset_credits: { available_count: 1 } })],
    ["non-2xx", () => new Response("busy", { status: 503 })],
    ["parse failure", () => new Response("not-json", { status: 200 })],
  ])("retains the cooldown for %s", async (_name, response) => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => response();
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("retains the cooldown after transport timeout", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("retains and releases a claim when quota admission is busy", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    const cleanup = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    try {
      await runCodexCooldownRecoveryProbes(config, due());
    } finally {
      cleanup();
    }
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("credential replacement during WHAM cannot clear the old cooldown", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => { await gate; return usageResponse(); };
    const run = runCodexCooldownRecoveryProbes(config, due());
    await Promise.resolve();
    saveCredential("a", "-new");
    release();
    await run;
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("a newer 429 during WHAM cannot be erased by the older probe", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => { await gate; return usageResponse(); };
    const run = runCodexCooldownRecoveryProbes(config, due());
    await Promise.resolve();
    recordCodexUpstreamOutcome(config, "a", 429, {
      now: due() + 1,
      resetAt: due() + 60 * 60_000,
      modelId: "gpt-5.6-sol",
    });
    release();
    await run;
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 2)).not.toBeNull();
  });

  test("concurrent worker passes coalesce into one WHAM request", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; await Promise.resolve(); return usageResponse(); };
    await Promise.all([
      runCodexCooldownRecoveryProbes(config, due()),
      runCodexCooldownRecoveryProbes(config, due()),
    ]);
    expect(calls).toBe(1);
  });

  test("shared recovery leaves Spark cooled", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "shared", START);
    cool(config, "a", "spark", START + 1);
    globalThis.fetch = async () => usageResponse();
    await runCodexCooldownRecoveryProbes(config, due(START + 1));
    expect(getCodexQuotaHealthSnapshot("a", "shared", due(START + 1) + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START + 1) + 1)).not.toBeNull();
  });

  test("an older Spark cooldown never starves the shared scope that can recover", async () => {
    // Spark is skipped at the claim site: generic WHAM carries no scope and can never prove a
    // spark recovery. Claiming it would spend the account's one claim per pass to settle false,
    // leaving the shared scope — which this evidence CAN clear — cooled behind it.
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "spark", START);
    cool(config, "a", "shared", START + 1);
    globalThis.fetch = async () => usageResponse();
    await runCodexCooldownRecoveryProbes(config, due(START + 1));
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START + 1) + 1)).not.toBeNull();
    expect(getCodexQuotaHealthSnapshot("a", "shared", due(START + 1) + 1)).toBeNull();
  });

  test("a Spark-only cooldown makes no upstream call at all", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "spark", START);
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due(START));
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START) + 1)).not.toBeNull();
  });

  test.each([
    ["retry-after", { retryAfter: "900" }],
    ["default", {}],
  ])("never claims %s cooldowns", async (_name, meta) => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    recordCodexUpstreamOutcome(config, "a", 429, { ...meta, now: START });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(calls).toBe(0);
  });

  test("non-pool OpenAI configurations never run recovery probes", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    config.providers.openai!.codexAccountMode = "direct";
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("oldest-first fairness probes every account beyond the per-pass limit", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const config = makeConfig(ids);
    for (const id of ids) {
      saveCredential(id);
      cool(config, id);
    }
    const seen: string[] = [];
    globalThis.fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("Authorization")?.replace("Bearer access-", "") ?? "");
      return new Response("busy", { status: 503 });
    };
    await runCodexCooldownRecoveryProbes(config, due());
    await runCodexCooldownRecoveryProbes(config, due() + 60_000);
    await runCodexCooldownRecoveryProbes(config, due() + 120_000);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});
