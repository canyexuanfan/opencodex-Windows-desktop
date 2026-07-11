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
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
}

function mockConfig(baseUrl: string, claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k" },
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
