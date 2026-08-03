import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import {
  clearReasoningReplayCacheForTests,
  peekReasoningForCall,
  rememberReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

/**
 * Regression coverage for opencodex issue #950: OpenCode Go DeepSeek V4 Flash
 * intermittently drops `reasoning_content` on tool-call continuations and the
 * upstream rejects the request with HTTP 400 ("The `reasoning_content` in the
 * thinking mode must be passed back to the API").
 *
 * The invariant: for every assistant message that contains `tool_calls`, the
 * openai-chat adapter must serialize a non-empty `reasoning_content` when the
 * provider originally returned one for that turn.
 *
 * Each test exercises one transformation path that used to break the
 * invariant; all four were red against the pre-fix code.
 */

const MODEL = "opencode-go/deepseek-v4-flash";
const REASONING = "I need to inspect files before answering.";

function configFor(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "key",
        models: ["deepseek-v4-flash"],
      },
    },
  };
}

function wireFor(input: unknown[]): { messages: Array<Record<string, unknown>> } {
  const parsed = parseRequest({ model: MODEL, input, stream: true });
  const route = routeModel(configFor(), parsed.modelId);
  parsed.modelId = route.modelId;
  const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
  return JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> };
}

const userMessage = () => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "inspect the repo" }],
});

const reasoningItem = () => ({
  type: "reasoning",
  id: "rs_1",
  summary: [],
  content: [{ type: "reasoning_text", text: REASONING }],
});

const functionCallItem = () => ({
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "read_file",
  arguments: '{"path":"README.md"}',
});

const functionCallOutputItem = () => ({
  type: "function_call_output",
  call_id: "call_1",
  output: "contents",
});

function toolCallAssistant(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
}

describe("issue #950 — tool-call reasoning replay invariant (openai-chat wire)", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("CONTROL: canonical full-history tool round keeps reasoning_content", () => {
    const { messages } = wireFor([userMessage(), reasoningItem(), functionCallItem(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP A: reasoning item arriving AFTER its function_call is attached to its turn", () => {
    // Reconstructed histories (resume/retry/synthetic) may order the reasoning
    // item after the call it belongs to. The parser used to clear the pending
    // buffer at function_call_output and serialize the turn bare.
    const { messages } = wireFor([userMessage(), functionCallItem(), reasoningItem(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP B: tool round surviving compaction without its reasoning sibling is re-attached from the replay cache", () => {
    // Mid-turn/remote compaction drops all Reasoning items while the open tool
    // round (function_call + output) can survive in the in-flight input. The
    // bridge recorded the reasoning under the call id on the original turn.
    rememberReasoningForCall("call_1", REASONING);
    const { messages } = wireFor([
      userMessage(),
      { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
      functionCallItem(),
      functionCallOutputItem(),
    ]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP C: orphan tool result (lost assistant turn) is repaired WITH the recorded reasoning", () => {
    // When previous_response_id expansion misses or history loses the assistant
    // turn, the adapter's orphan repair synthesizes an assistant tool_call; it
    // must carry the reasoning recorded for that call id.
    rememberReasoningForCall("call_1", REASONING);
    const { messages } = wireFor([userMessage(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("documented non-bug: opaque encrypted-only reasoning is intentionally not replayed", () => {
    // Native (non-ocxr1) encrypted reasoning has no readable text; the parser
    // deliberately degrades instead of inventing replayable plaintext. Not a
    // candidate for the opencode-go path (its reasoning is plaintext/ocxr1).
    const { messages } = wireFor([
      userMessage(),
      { type: "reasoning", id: "rs_1", encrypted_content: "some-opaque-blob" },
      functionCallItem(),
      functionCallOutputItem(),
    ]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBeUndefined();
  });
});

describe("issue #950 — reasoning replay cache bounds", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("recorded reasoning is readable under the same call id and does not leak across ids", () => {
    rememberReasoningForCall("call_a", "alpha reasoning");
    rememberReasoningForCall("call_b", "beta reasoning");
    expect(peekReasoningForCall("call_a")).toBe("alpha reasoning");
    expect(peekReasoningForCall("call_b")).toBe("beta reasoning");
    expect(peekReasoningForCall("call_c")).toBeUndefined();
  });

  test("entries expire after the TTL", () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningForCall("call_ttl", "stale reasoning");
    expect(peekReasoningForCall("call_ttl")).toBe("stale reasoning");
    clock += 60 * 60 * 1000 + 1;
    expect(peekReasoningForCall("call_ttl")).toBeUndefined();
    clearReasoningReplayCacheForTests();
  });

  test("older entries are evicted when the entry cap is exceeded", () => {
    for (let i = 0; i < 70; i++) rememberReasoningForCall(`call_${i}`, `reasoning ${i}`);
    const oldest = peekReasoningForCall("call_0");
    // The first six entries (0..5) must have been evicted to make room for
    // calls 64..69 under MAX_ENTRIES = 64.
    expect(oldest).toBeUndefined();
    expect(peekReasoningForCall("call_63")).toBe("reasoning 63");
    expect(peekReasoningForCall("call_69")).toBe("reasoning 69");
  });

  test("empty and oversized entries are ignored", () => {
    rememberReasoningForCall("", "no id");
    rememberReasoningForCall("call_empty", "");
    expect(peekReasoningForCall("call_empty")).toBeUndefined();
    const huge = "x".repeat(300 * 1024);
    rememberReasoningForCall("call_huge", huge);
    expect(peekReasoningForCall("call_huge")).toBeUndefined();
  });
});
