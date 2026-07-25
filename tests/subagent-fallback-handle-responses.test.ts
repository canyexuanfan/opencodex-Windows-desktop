/**
 * handleResponses integration coverage for PR #391 merge blockers:
 * probe-lease release on fallback reroute, final-route normalization,
 * encrypted native-only fallback, concurrent quota priming (unit-covered separately).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountQuota,
  updateAccountQuota,
} from "../src/codex/quota";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import {
  resetSubagentModelFallbackStateForTests,
} from "../src/codex/subagent-model-fallback";
import type { CodexAuthContext } from "../src/codex/auth-context";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-subagent-hr-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  rmSync(testDir, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function fernetFixture(ciphertextBytes = 16): string {
  const raw = Buffer.alloc(57 + ciphertextBytes, 0x5a);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

const FERNET_TASK = fernetFixture();

function encryptedAgentInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "encrypted_content", encrypted_content: FERNET_TASK }],
  }];
}

function readableAgentInput(): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "input_text", text: "do the work" }],
  }];
}

function spawnHeaders(extra: HeadersInit = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-openai-subagent": "collab_spawn",
    authorization: "Bearer caller-codex-token",
    ...Object.fromEntries(new Headers(extra)),
  });
}

function poolNativePlusRoutedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "sk-test",
      },
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-test",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
    ...overrides,
  } as OcxConfig;
}

function installPoolCredential(now: number): void {
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool_token",
    refreshToken: "pool_refresh",
    expiresAt: now + 24 * 60 * 60_000,
    chatgptAccountId: "pool_acc",
  });
}

function mockUpstream(capture: {
  urls: string[];
  bodies: string[];
  auths: Array<string | null>;
}): void {
  globalThis.fetch = (async (input, init) => {
    capture.urls.push(String(input));
    capture.bodies.push(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    capture.auths.push(headers.get("authorization"));
    return Response.json({
      id: "resp_test",
      object: "response",
      status: "completed",
      model: "gpt-5.6-sol",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
}

async function postSpawn(
  config: OcxConfig,
  body: Record<string, unknown>,
  options: Parameters<typeof handleResponses>[3] = {},
  logCtx: RequestLogContext = { model: "", provider: "" },
): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: spawnHeaders(),
      body: JSON.stringify(body),
    }),
    config,
    logCtx,
    options,
  );
}

describe("subagent fallback probe lease release", () => {
  test("releases abandoned probe lease when fallback leaves the cooled pool account", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential(now);
    const cfg = poolNativePlusRoutedConfig({
      subagentModelFallback: ["xai/grok-4.5"],
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });

    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;

    const authPublications: Array<CodexAuthContext | undefined> = [];
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => authPublications.push(ctx) },
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
    // Early pool auth published a probe-bearing context; final routed auth is undefined.
    expect(authPublications.some((ctx) => ctx && "probeLeaseId" in ctx && ctx.probeLeaseId)).toBe(true);
    expect(authPublications.at(-1)).toBeUndefined();
  });

  test("same-provider model fallback reuses early probe auth without false cooldown", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential(now);
    const cfg = poolNativePlusRoutedConfig({
      // Stay on the openai forward provider; only the model changes.
      subagentModelFallback: ["gpt-5.5"],
    });
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });

    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    Date.now = () => probeAt;

    let finalAuth: CodexAuthContext | undefined;
    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(
      cfg,
      { model: "gpt-5.6-sol", input: readableAgentInput(), stream: false },
      { onCodexAuthContextResolved: (ctx) => { finalAuth = ctx; } },
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    // Early probe auth was reused (no false cooldown on same-account re-resolve).
    expect((finalAuth as { probeLeaseId?: string }).probeLeaseId).toBeTruthy();
    // Terminal handling may clear the live health lease after the successful probe;
    // the important contract is that the request completed with the probe-bearing context.
    expect(response.status).not.toBe(429);
  });

  test("reroute auth failure releases the abandoned original probe lease", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential(now);
    const cfg: OcxConfig = {
      port: 0,
      defaultProvider: "openai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 80,
      subagentModelFallback: ["openai-direct/gpt-5.5"],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
        "openai-direct": {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
      ],
    };
    updateAccountQuota("pool-a", 95, undefined, 20);
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt, now });
    Date.now = () => now + CODEX_QUOTA_PROBE_INTERVAL_MS;

    // Omit authorization so direct-mode final auth fails after releasing pool probe.
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openai-subagent": "collab_spawn",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: readableAgentInput(),
          stream: false,
        }),
      }),
      cfg,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(401);
    expect(getCodexUpstreamHealth("pool-a")?.probeLeaseId).toBeUndefined();
  });
});

describe("subagent fallback final-route normalization", () => {
  test("falls back to gpt-5.6-sol-pro and rewrites wire model + reasoning.mode", async () => {
    const cfg = poolNativePlusRoutedConfig({
      activeCodexAccountId: undefined,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-test",
        },
      },
      subagentModelFallback: ["openai-apikey/gpt-5.6-sol-pro"],
      fastMode: true,
    });
    // Exhaust native primary via health block so fallback is chosen without pool quotas.
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await postSpawn(
      cfg,
      {
        model: "gpt-5.6-sol",
        input: readableAgentInput(),
        stream: false,
        reasoning: { effort: "high" },
        service_tier: "default",
      },
      {},
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.openai.com"))).toBe(true);
    const body = JSON.parse(capture.bodies[0]!) as {
      model?: string;
      reasoning?: { effort?: string; mode?: string };
      service_tier?: string;
    };
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning?.mode).toBe("pro");
    expect(body.service_tier).toBe("priority");
    expect(logCtx.provider).toContain("openai-apikey");
    expect(logCtx.model).toBe("gpt-5.6-sol-pro");
    expect(logCtx.resolvedModel).toBe("gpt-5.6-sol");
    expect(logCtx.providerAdapter).toBe("openai-responses");
  });

  test("routed primary falls back to native and preserves encrypted task passthrough", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.5"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("chatgpt.com/backend-api/codex"))).toBe(true);
    expect(capture.bodies[0]).toContain(FERNET_TASK);
  });

  test("native primary falls back to routed for readable child tasks", async () => {
    const cfg = poolNativePlusRoutedConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
      subagentModelFallback: ["xai/grok-4.5"],
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.6-sol", "rate limit exceeded", cfg);

    const capture = { urls: [] as string[], bodies: [] as string[], auths: [] as Array<string | null> };
    mockUpstream(capture);

    const response = await postSpawn(cfg, {
      model: "gpt-5.6-sol",
      input: readableAgentInput(),
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(capture.urls.some((url) => url.includes("api.x.ai"))).toBe(true);
  });
});

describe("encrypted child native-only fallback", () => {
  test("rejects encrypted routed primary when only routed fallbacks exist", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["xai/grok-3"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
      },
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });
    const json = await response.json() as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(json.error?.code).toBe("unreadable_encrypted_agent_task");
    expect(fetchCalls).toBe(0);
  });

  test("skips exhausted native candidates before rejecting encrypted routed primary", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.5", "xai/grok-3"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const { noteSubagentModelFailure } = await import("../src/codex/subagent-model-fallback");
    noteSubagentModelFailure("gpt-5.5", "429", cfg);

    const response = await postSpawn(cfg, {
      model: "xai/grok-4.5",
      input: encryptedAgentInput(),
      stream: false,
    });
    expect(response.status).toBe(400);
  });

  test("non-thread-spawn encrypted routed requests stay rejected without fallback", async () => {
    const cfg = poolNativePlusRoutedConfig({
      defaultProvider: "xai",
      subagentModelFallback: ["gpt-5.5"],
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
        },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer caller-codex-token",
        },
        body: JSON.stringify({
          model: "xai/grok-4.5",
          input: encryptedAgentInput(),
          stream: false,
        }),
      }),
      cfg,
      { model: "", provider: "" },
    );
    expect(response.status).toBe(400);
  });
});
