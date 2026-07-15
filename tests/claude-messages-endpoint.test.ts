import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-endpoint-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-endpoint-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function mockChatUpstream() {
  return mockChatUpstreamCapturing().server;
}

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string, claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
    },
    ...(claudeCode ? { claudeCode } : {}),
  } as OcxConfig;
}

test("POST /v1/messages?beta=true streams an Anthropic-shaped turn end to end", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await response.text();
    const names = [...text.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names).toContain("content_block_stop");
    expect(names.at(-2)).toBe("message_delta");
    expect(names.at(-1)).toBe("message_stop");
    expect(text).toContain("\"text_delta\"");
    expect(text).toContain("Hello");
    expect(text).toContain("\"stop_reason\":\"end_turn\"");

    // Request log regression (live smoke round 2): the tap must see the PRE-translation
    // Responses stream — the translated Anthropic stream has no response.completed, which
    // used to record a bogus 502 with no usage.
    const logs = await (await fetch(new URL("/api/logs", server.url))).json() as {
      status: number; model: string; usage?: { inputTokens: number; outputTokens: number }; usageStatus: string;
    }[];
    const row = logs.find(l => l.model === "test-model" || l.model === "mock/test-model");
    expect(row).toBeDefined();
    expect(row!.status).toBe(200);
    expect(row!.usage?.inputTokens).toBe(12);
    expect(row!.usage?.outputTokens).toBe(3);

    const claudeUsage = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(res => res.json()) as {
      surface: string;
      summary: { requests: number; totalTokens: number };
      models: Array<{ model: string }>;
    };
    expect(claudeUsage.surface).toBe("claude");
    expect(claudeUsage.summary).toMatchObject({ requests: 1, totalTokens: 15 });
    expect(claudeUsage.models).toEqual([expect.objectContaining({ model: "test-model" })]);

    const codexUsage = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(res => res.json()) as {
      surface: string;
      summary: { requests: number };
    };
    expect(codexUsage.surface).toBe("codex");
    expect(codexUsage.summary.requests).toBe(0);
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("non-streaming /v1/messages returns an Anthropic message JSON", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, any>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.model).toBe("mock/test-model");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content[0].type).toBe("text");
    expect(json.content[0].text).toContain("Hello");
    expect(typeof json.usage.input_tokens).toBe("number");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("native Anthropic passthrough clears the header deadline before streaming the body", async () => {
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          }, 600);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const config = mockConfig("http://127.0.0.1:1/v1", {
    anthropicBaseUrl: upstream.url.toString().replace(/\/$/, ""),
  });
  config.connectTimeoutMs = 200;
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("native openai-responses route carries prompt_cache_key + synthesized session_id header", async () => {
  const capture: { headers?: Record<string, string>; body?: Record<string, any> } = {};
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/responses")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      capture.headers = Object.fromEntries(req.headers);
      capture.body = await req.json() as Record<string, any>;
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_1", status: "in_progress" } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "Hello" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "native",
    providers: {
      native: { adapter: "openai-responses", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, authMode: "forward", allowPrivateNetwork: true },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "native/gpt-test",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "user_abc123_account__session_11111111-2222-3333-4444-555555555555" },
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "high" },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    // Native ChatGPT route: sampling params + user are stripped, but the cache-affinity
    // pair survives — prompt_cache_key in the body and a synthesized session_id header
    // (devlog 090: without the header the backend reported cached_tokens: 0 every turn).
    expect(capture.body?.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    expect(capture.body?.user).toBeUndefined();
    expect(capture.body?.max_output_tokens).toBeUndefined();
    expect(capture.body?.reasoning?.effort).toBe("high");
    expect(capture.headers?.["session_id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("routed Claude requests give OpenAI sidecars main auth without leaking it to the routed provider", async () => {
  const mainAccessToken = "main-chatgpt-access";
  const mainAccountId = "main-chatgpt-account";
  const imageBytes = "aGVsbG8taW1hZ2UtYnl0ZXM=";
  const visionCaption = "A red OPENCODEX logo on a white background.";
  const sidecarCalls: Array<{ headers: Headers; body: Record<string, any>; kind: "vision" | "web-search" }> = [];
  const routedCalls: Array<{ authorization: string | null; body: Record<string, any> }> = [];

  const forward = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, any>;
      const kind = Array.isArray(body.tools) && body.tools.some((tool: Record<string, unknown>) => tool.type === "web_search")
        ? "web-search"
        : "vision";
      sidecarCalls.push({ headers: new Headers(req.headers), body, kind });
      const text = kind === "vision" ? visionCaption : "OpenCodex search results are available.";
      return new Response([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const routed = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, any>;
      routedCalls.push({ authorization: req.headers.get("authorization"), body });
      const choosesWebSearch = routedCalls.length === 1
        && Array.isArray(body.tools)
        && body.tools.some((tool: Record<string, any>) => tool.function?.name === "web_search");
      const frames = choosesWebSearch
        ? [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", function: { name: "web_search", arguments: '{"query":"latest opencodex"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ index: 0, delta: { content: "Routed answer" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
      return new Response(
        frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const config = {
    port: 0,
    defaultProvider: "routed",
    providers: {
      forward: {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: `${forward.url.toString().replace(/\/$/, "")}/v1`,
        allowPrivateNetwork: true,
      },
      routed: {
        adapter: "openai-chat",
        baseUrl: `${routed.url.toString().replace(/\/$/, "")}/v1`,
        apiKey: "routed-provider-key",
        allowPrivateNetwork: true,
        noVisionModels: ["text-model"],
      },
    },
    webSearchSidecar: { backend: "openai" },
    visionSidecar: { backend: "openai" },
  } as OcxConfig;
  saveConfig(config);
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: mainAccessToken, account_id: mainAccountId },
  }));
  const server = startServer(0);
  const requestBody = {
    model: "routed/text-model",
    max_tokens: 128,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Search for OpenCodex and inspect this logo." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes } },
      ],
    }],
  };
  try {
    const authenticated = await postMessages(server.url.toString(), requestBody);
    expect(authenticated.status).toBe(200);
    await authenticated.text();

    expect(sidecarCalls.map(call => call.kind).sort()).toEqual(["vision", "web-search"]);
    for (const call of sidecarCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${mainAccessToken}`);
      expect(call.headers.get("chatgpt-account-id")).toBe(mainAccountId);
    }
    expect(sidecarCalls.find(call => call.kind === "vision")?.body.input).toEqual(expect.any(Array));
    expect(sidecarCalls.find(call => call.kind === "web-search")?.body.tools?.[0]?.type).toBe("web_search");
    expect(routedCalls.length).toBe(2);
    expect(routedCalls.every(call => call.authorization === "Bearer routed-provider-key")).toBe(true);
    const authenticatedRoutedBodies = JSON.stringify(routedCalls.map(call => call.body));
    expect(authenticatedRoutedBodies).toContain(visionCaption);
    expect(authenticatedRoutedBodies).not.toContain("[image omitted:");
    expect(authenticatedRoutedBodies).not.toContain(imageBytes);

    rmSync(join(isolatedCodexHome!.path, "auth.json"));
    const sidecarCountBeforeNoLogin = sidecarCalls.length;
    const noLogin = await postMessages(server.url.toString(), requestBody);
    expect(noLogin.status).toBe(200);
    await noLogin.text();

    expect(sidecarCalls.length).toBe(sidecarCountBeforeNoLogin);
    expect(routedCalls.at(-1)?.authorization).toBe("Bearer routed-provider-key");
    const noLoginBody = JSON.stringify(routedCalls.at(-1)?.body);
    expect(noLoginBody).toContain("[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]");
    expect(noLoginBody).not.toContain(imageBytes);
  } finally {
    server.stop(true);
    forward.stop(true);
    routed.stop(true);
  }
});

test("bad body -> Anthropic-shaped 400; unknown /v1 path guard intact", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const bad = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
    });
    expect(bad.status).toBe(400);
    const badJson = await bad.json() as Record<string, any>;
    expect(badJson).toEqual({ type: "error", error: { type: "invalid_request_error", message: "model is required" } });

    const unknown = await fetch(new URL("/v1/does-not-exist", server.url), { method: "POST" });
    expect(unknown.status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("count_tokens returns a positive estimate in the exact contract shape", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        system: "be brief",
        messages: [{ role: "user", content: "count me please, this is a sentence" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["input_tokens"]);
    expect(json.input_tokens as number).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test("claudeCode.enabled=false -> 403 permission_error on both routes", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1", { enabled: false }));
  const server = startServer(0);
  try {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await fetch(new URL(path, server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
      });
      expect(response.status).toBe(403);
      const json = await response.json() as Record<string, any>;
      expect(json.error.type).toBe("permission_error");
    }
  } finally {
    server.stop(true);
  }
});

async function postMessages(serverUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL("/v1/messages", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

test("effort safety valve: routes with a definitive no-effort ladder get reasoning stripped (devlog 136 B6)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  const base = `${upstream.url.toString().replace(/\/$/, "")}/v1`;
  const config = mockConfig(base);
  (config.providers.mock as Record<string, unknown>).noReasoningModels = ["test-model"];
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.reasoning_effort).toBeUndefined();
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("unknown-ladder routes keep the requested effort (no false stripping)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.reasoning_effort).toBe("low");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("defensive [1m] strip: a leaked context-variant marker still routes to the bare model (devlog 138)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model[1m]",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.model).toBe("test-model");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("count_tokens is CJK-aware: Korean body counts more tokens than equal-length English (devlog 260712 B3)", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const count = async (content: string) => {
      const res = await fetch(new URL("/v1/messages/count_tokens", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "placeholder" },
        body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content }] }),
      });
      return (await res.json() as { input_tokens: number }).input_tokens;
    };
    const korean = "가나다라마바사아자차카타파하".repeat(40);
    const english = "abcdefghijklmn".repeat(40); // same char length
    expect(korean.length).toBe(english.length);
    expect(await count(korean)).toBeGreaterThan(await count(english));
  } finally {
    server.stop(true);
  }
});
