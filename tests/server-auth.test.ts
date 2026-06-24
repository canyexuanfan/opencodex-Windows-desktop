import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex-account-store";
import { clearAccountNeedsReauth } from "../src/codex-auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex-routing";
import { saveConfig } from "../src/config";
import {
  assertServerAuthConfig,
  corsHeaders,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  safeConfigDTO,
  startServer,
} from "../src/server";
import type { OcxConfig } from "../src/types";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");

function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { Authorization: "Bearer provider-secret", "X-Custom": "secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("server local API auth", () => {
  test("loopback hostnames do not require opencodex API auth", () => {
    expect(isLoopbackHostname(undefined)).toBe(true);
    expect(isLoopbackHostname("")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isApiAuthRequired(config())).toBe(false);
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
  });

  test("non-loopback binding requires env token before startup", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).toThrow("OPENCODEX_API_AUTH_TOKEN");

    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).not.toThrow();
  });

  test("auth header must match env token when non-loopback auth is required", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    const cfg = config("0.0.0.0");

    expect(hasValidApiAuth(new Request("http://localhost/api/config"), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "wrong" },
    }), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "local-secret" },
    }), cfg)).toBe(true);
  });

  test("loopback remains allowed even when env token exists", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(hasValidApiAuth(new Request("http://localhost/api/config"), config("127.0.0.1"))).toBe(true);
  });

  test("CORS preflight permits the opencodex API key header", () => {
    expect(corsHeaders()["Access-Control-Allow-Headers"]).toContain("X-OpenCodex-API-Key");
  });

  test("safeConfigDTO redacts provider secrets and exposes booleans", () => {
    const dto = safeConfigDTO(config("127.0.0.1")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(JSON.stringify(dto)).not.toContain("sk-secret-value");
    expect(JSON.stringify(dto)).not.toContain("provider-secret");
    expect(dto.providers.openai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      hasApiKey: true,
      hasHeaders: true,
    });
    expect(dto.providers.openai).not.toHaveProperty("apiKey");
    expect(dto.providers.openai).not.toHaveProperty("headers");
  });

  test("expired thread affinity returns 409 before HTTP or WebSocket passthrough", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    let upstreamRequests = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        upstreamRequests += 1;
        return Response.json({ id: "resp_test", object: "response", status: "completed", output: [] });
      },
    });
    const now = 1_800_000_000_000;
    saveConfig({
      port: 0,
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url}backend-api/codex`,
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const originalNow = Date.now;
    const server = startServer(0);
    try {
      Date.now = () => now;
      for (const threadId of ["expired-http", "expired-ws"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer inbound-main-token",
            "x-codex-parent-thread-id": threadId,
          },
          body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
        });
        expect(response.status).toBe(200);
      }
      expect(upstreamRequests).toBe(2);

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      const httpResponse = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
          "x-codex-parent-thread-id": "expired-http",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });
      expect(httpResponse.status).toBe(409);

      const wsResponse = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          authorization: "Bearer inbound-main-token",
          connection: "Upgrade",
          upgrade: "websocket",
          "x-codex-parent-thread-id": "expired-ws",
        },
      });
      expect(wsResponse.status).toBe(409);
      expect(upstreamRequests).toBe(2);
    } finally {
      Date.now = originalNow;
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("passthrough connect failure records selected pool account health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    saveConfig({
      port: 0,
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: "http://127.0.0.1:9/backend-api/codex",
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
      connectTimeoutMs: 200,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });

      expect(response.status).toBe(502);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 1,
        lastFailureStatus: 0,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("passthrough SSE terminal failure is recorded without clearing health on initial 200", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const cfg = {
      port: 0,
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url}backend-api/codex`,
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig;
    saveConfig(cfg);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 3,
        lastFailureStatus: 502,
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("non-forward generated stream does not mutate active pool health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            'data: {"error":{"message":"upstream failed","code":"server_error"}}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: `${upstream.url}v1`,
          apiKey: "provider-key",
          defaultModel: "gpt-test",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.failed");
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });
});
