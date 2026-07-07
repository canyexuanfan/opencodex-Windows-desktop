import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-keyfail-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keyfail-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearKeyCooldowns();
});

describe("server 429 key failover (end-to-end)", () => {
  test("routed 429 rotates to the pool's next key and succeeds", async () => {
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        if (seenAuth.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429, headers: { "retry-after": "30", "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
      providers: {
        pooled: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      const message = json.output?.find(o => o.type === "message");
      expect(message?.content?.[0]?.text).toBe("ok after rotate");
      expect(seenAuth[0]).toBe("Bearer key-alpha-000111222333");
      expect(seenAuth[1]).toBe("Bearer key-beta-444555666777");
    } finally {
      server.stop(true);
    }
  });

  test("noVisionModels model with no sidecar plan gets images stripped fail-closed", async () => {
    let upstreamBody = "";
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        upstreamBody = await req.text();
        return new Response(JSON.stringify({
          id: "chatcmpl-2", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "text only" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        // No forward provider in config → planVisionSidecar cannot run.
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "textonly/blind-model", stream: false,
          input: [{ type: "message", role: "user", content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ]}],
        }),
      });
      expect(res.status).toBe(200);
      expect(upstreamBody).toContain("[image omitted");
      expect(upstreamBody).not.toContain("aGVsbG8=");
    } finally {
      server.stop(true);
    }
  });
});
