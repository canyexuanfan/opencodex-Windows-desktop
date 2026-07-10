/**
 * /v1/images/{generations,edits} relay (issue #83): codex-rs's image_gen extension POSTs these
 * paths against the injected base_url, so the proxy must relay them to an OpenAI-family upstream
 * instead of the /v1/* JSON-404 guard.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-server-images-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-images-codex-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

interface CapturedRequest {
  path: string;
  headers: Headers;
  body: unknown;
}

function fakeImagesUpstream(captured: CapturedRequest[], status = 200, payload?: unknown) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return Response.json(
        payload ?? { created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] },
        { status },
      );
    },
  });
}

// Named "chatgpt" so startServer's auto-upsert of the real ChatGPT provider does not add a
// second forward candidate pointing at the live chatgpt.com backend.
function forwardConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: { adapter: "openai-responses", baseUrl, authMode: "forward" },
    },
  } as OcxConfig;
}

/** Keeps startServer from upserting a live chatgpt.com forward provider into the test config. */
const disabledChatgptProvider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward",
  disabled: true,
} as const;

/** An ENABLED forward provider whose relay would fail loudly if it were (wrongly) used. */
const unreachableChatgptProvider = {
  adapter: "openai-responses",
  baseUrl: "http://127.0.0.1:1/backend-api/codex",
  authMode: "forward",
} as const;

function keyedProvider(baseUrl: string) {
  return { adapter: "openai-responses", baseUrl, apiKey: "sk-platform-key" };
}

test("POST /v1/images/generations relays to the ChatGPT forward provider with forwarded auth", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-user-token",
        "chatgpt-account-id": "acct-123",
      },
      body: JSON.stringify({ prompt: "a halftone gothic hero", model: "gpt-image-2", size: "auto" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 1_767_000_000, data: [{ b64_json: "aGVsbG8=" }] });

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/images/generations");
    expect(captured[0].headers.get("authorization")).toBe("Bearer chatgpt-user-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(captured[0].body).toMatchObject({ prompt: "a halftone gothic hero", model: "gpt-image-2" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("POST /v1/images/edits relays to the /images/edits upstream path", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/edits", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({
        prompt: "add gold ink",
        model: "gpt-image-2",
        images: [{ image_url: "data:image/png;base64,aGk=" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/images/edits");
    expect(captured[0].body).toMatchObject({ prompt: "add gold ink" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a routed pool account's token overrides the caller bearer on the forward relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-access-token",
    refreshToken: "pool-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-a",
  });

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    // Pool routing selected pool-a; the caller token must NOT reach upstream.
    expect(captured[0].headers.get("authorization")).toBe("Bearer pool-access-token");
    expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-pool-a");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("zstd-compressed request bodies are decoded before the relay", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const raw = JSON.stringify({ prompt: "compressed prompt", model: "gpt-image-2" });
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
        authorization: "Bearer chatgpt-user-token",
      },
      body: Bun.zstdCompressSync(Buffer.from(raw)),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("content-encoding")).toBeNull();
    expect(captured[0].body).toMatchObject({ prompt: "compressed prompt" });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("falls back to a keyed openai-responses provider when no forward provider exists", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    providers: {
      chatgpt: disabledChatgptProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The caller's ChatGPT OAuth token must NOT reach a platform API-key upstream.
        authorization: "Bearer chatgpt-user-token",
      },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
    // Keyed baseUrl had no /v1 suffix — the relay normalizes to the platform path.
    expect(captured[0].path).toBe("/v1/images/generations");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("keyed baseUrl with a /v1 suffix is normalized (no double /v1)", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "openai-apikey",
    providers: {
      chatgpt: disabledChatgptProvider,
      "openai-apikey": keyedProvider(`${upstream.url.toString().replace(/\/$/, "")}/v1`),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/images/generations");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unauthenticated request skips the forward provider when a keyed provider exists", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "chatgpt",
    providers: {
      // ENABLED forward provider: an accidental forward relay would fail loudly (port 1).
      chatgpt: unreachableChatgptProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("an unauthenticated request gets 401 when only the forward provider exists", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "chatgpt",
    providers: { chatgpt: unreachableChatgptProvider },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("ChatGPT auth");
  } finally {
    await server.stop(true);
  }
});

test("forward-auth failure falls back to the keyed provider instead of surfacing 401", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: unreachableChatgptProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    // pool-a has NO stored credential, so forward-auth resolution throws CodexAuthContextError.
    activeCodexAccountId: "pool-a",
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("forward-auth failure surfaces its own error when no keyed provider exists", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "chatgpt",
    providers: { chatgpt: unreachableChatgptProvider },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(401);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("reauthentication");
  } finally {
    await server.stop(true);
  }
});

test("returns an honest 400 when no OpenAI-family upstream is configured", async () => {
  saveConfig({
    port: 0,
    defaultProvider: "groq",
    providers: {
      chatgpt: disabledChatgptProvider,
      groq: { adapter: "openai-chat", baseUrl: "https://api.groq.example/v1", apiKey: "gsk-x" },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    // 4xx (not 5xx): codex retries every 5xx up to 5 total attempts, and this is a permanent
    // configuration state. The actionable part is the message, which codex Debug-prints into
    // the model-visible tool failure.
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { type: string; message: string } };
    expect(json.error.message).toContain("image generation");
    expect(json.error.message).toContain("disable image_generation");
  } finally {
    await server.stop(true);
  }
});

test("relays upstream error status and body verbatim", async () => {
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured, 403, {
    error: { message: "Your plan does not allow image generation.", type: "forbidden" },
  });
  saveConfig(forwardConfig(upstream.url.toString().replace(/\/$/, "")));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(403);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toBe("Your plan does not allow image generation.");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a hung upstream times out with 504 after config.images.timeoutMs", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      return new Promise<Response>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("client aborted")), { once: true });
      });
    },
  });
  saveConfig({
    ...forwardConfig(upstream.url.toString().replace(/\/$/, "")),
    images: { timeoutMs: 100 },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-user-token" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(504);
    const json = await response.json() as { error: { message: string } };
    expect(json.error.message).toContain("timed out");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}, 5_000);

test("GET /v1/images/generations still falls through to the JSON 404 guard", async () => {
  saveConfig(forwardConfig("https://chatgpt.example/backend-api/codex"));

  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/images/generations", server.url));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  } finally {
    await server.stop(true);
  }
});

test("images routes require API auth and local Origin on non-loopback bindings", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  saveConfig({
    ...forwardConfig("https://chatgpt.example/backend-api/codex"),
    hostname: "0.0.0.0",
  });

  const server = startServer(0);
  const imagesUrl = `http://127.0.0.1:${server.port}/v1/images/generations`;
  try {
    const missingAuth = await fetch(imagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(missingAuth.status).toBe(401);

    const badOrigin = await fetch(imagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencodex-api-key": "local-secret",
        origin: "https://attacker.test",
      },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(badOrigin.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("the proxy admission secret is never relayed to the forward upstream", async () => {
  process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
  const captured: CapturedRequest[] = [];
  const upstream = fakeImagesUpstream(captured);
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: unreachableChatgptProvider,
      "openai-apikey": keyedProvider(upstream.url.toString().replace(/\/$/, "")),
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    // Authorization carries the proxy's OWN admission token — it authenticates the caller to the
    // proxy, but must be stripped before upstream selection (else it would leak to chatgpt.com).
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-platform-key");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});
