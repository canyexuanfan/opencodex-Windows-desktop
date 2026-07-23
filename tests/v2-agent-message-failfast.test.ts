import { afterEach, describe, expect, test } from "bun:test";
import {
  handleResponses,
  hasUnreadableEncryptedAgentTask,
} from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const FERNET_TASK = `gAAAA${"Ab1_-".repeat(20)}==`;
const ROUTING_ENVELOPE = [
  "Message Type: NEW_TASK",
  "Task name: /root/worker",
  "Sender: /root",
  "Payload:",
  "",
].join("\n");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function agentMessage(content: Array<Record<string, unknown>>): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content,
  }];
}

function routedConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
    },
  } as OcxConfig;
}

function nativeConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

async function post(
  config: OcxConfig,
  model: string,
  input: unknown[],
  headers: HeadersInit = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify({ model, input, stream: false }),
  }), config, { model: "", provider: "" });
}

describe("V2 routed agent-message ciphertext guard", () => {
  test("blocks a pure Fernet-only agent task", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(true);
  });

  test("blocks a routing envelope followed only by a Fernet task", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(true);
  });

  test("blocks a control preamble mixed into the Fernet slot before sanitization", async () => {
    const input = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      {
        type: "encrypted_content",
        encrypted_content: `[CXC-LEAF-GUARD] follow the worker boundary.\n\n${FERNET_TASK}`,
      },
    ]);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("provider dispatch must not happen");
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", input);
    const raw = await response.text();
    const json = JSON.parse(raw) as {
      error?: { type?: string; code?: string; message?: string };
    };

    expect(response.status).toBe(400);
    expect(json.error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(json.error?.message).toContain("encrypted");
    expect(fetchCalls).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("gAAAA");
  });

  test("allows genuine readable task text after the envelope", () => {
    expect(hasUnreadableEncryptedAgentTask(agentMessage([
      {
        type: "input_text",
        text: `${ROUTING_ENVELOPE}Implement the focused regression test.`,
      },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]))).toBe(false);
  });

  test("ignores encrypted reasoning and compaction items", () => {
    expect(hasUnreadableEncryptedAgentTask([
      { type: "reasoning", encrypted_content: FERNET_TASK, summary: [] },
      { type: "compaction", encrypted_content: FERNET_TASK },
    ])).toBe(false);
  });

  test("allows the canonical ChatGPT route to forward the encrypted task", async () => {
    let forwardedBody = "";
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const input = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: FERNET_TASK },
    ]);
    const response = await post(nativeConfig(), "gpt-5.5", input, {
      authorization: "Bearer caller-codex-token",
    });

    expect(response.status).toBe(200);
    expect(forwardedBody).toContain(FERNET_TASK);
  });
});
