import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { sseFieldOffset, sseFieldValue } from "../src/lib/sse-decoder";
import { parseSidecarSSE } from "../src/web-search/parse";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

// #1170: the space after the colon is optional in text/event-stream. Several parsers required it
// and silently dropped every frame from a compliant producer that omits it, which surfaced to the
// user as a completed turn with no content.

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("sseFieldValue", () => {
  test("accepts both spaced and unspaced field values", () => {
    expect(sseFieldValue('data: {"a":1}', "data")).toBe('{"a":1}');
    expect(sseFieldValue('data:{"a":1}', "data")).toBe('{"a":1}');
    expect(sseFieldValue("event: message_start", "event")).toBe("message_start");
    expect(sseFieldValue("event:message_start", "event")).toBe("message_start");
  });

  test("strips at most one leading space so payload whitespace survives", () => {
    expect(sseFieldValue("data:  two-spaces", "data")).toBe(" two-spaces");
  });

  test("returns null for a different field, a bare prefix, or a comment", () => {
    expect(sseFieldValue("event: x", "data")).toBeNull();
    expect(sseFieldValue("database: x", "data")).toBeNull();
    expect(sseFieldValue("data", "data")).toBeNull();
    expect(sseFieldValue(": keepalive", "data")).toBeNull();
  });

  test("an empty value is a value, not an absent field", () => {
    expect(sseFieldValue("data:", "data")).toBe("");
    expect(sseFieldValue("data: ", "data")).toBe("");
  });

  test("does not trim the value — callers own that", () => {
    expect(sseFieldValue("data: payload  ", "data")).toBe("payload  ");
  });
});

describe("sseFieldOffset", () => {
  const frame = 'event:start\ndata:{"a":1}\nother: x';

  test("returns the value offset for spaced and unspaced fields", () => {
    expect(frame.slice(sseFieldOffset(frame, 0, 11, "event"), 11)).toBe("start");
    expect(frame.slice(sseFieldOffset(frame, 12, 24, "data"), 24)).toBe('{"a":1}');
  });

  test("returns -1 for a different field", () => {
    expect(sseFieldOffset(frame, 25, frame.length, "data")).toBe(-1);
  });

  test("agrees with sseFieldValue on the same line", () => {
    for (const line of ["data: x", "data:x", "data:", "data:  y", "event:z"]) {
      const offset = sseFieldOffset(line, 0, line.length, "data");
      const value = sseFieldValue(line, "data");
      if (value === null) expect(offset).toBe(-1);
      else expect(line.slice(offset)).toBe(value);
    }
  });
});

describe("openai-chat adapter (#1170)", () => {
  test("accepts unspaced data frames and finish_reason without [DONE]", async () => {
    const response = new Response([
      'data:{"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data:{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));

    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("hello");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("accepts an unspaced [DONE] sentinel", async () => {
    const response = new Response([
      'data:{"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data:[DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
  });

  test("still handles the spaced form identically", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("hi");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("web-search sidecar parser (#1170)", () => {
  function sseStream(body: string): Response {
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }

  const frames = (prefix: string) => [
    `${prefix}{"type":"response.output_text.delta","delta":"answer"}\n\n`,
    `${prefix}{"type":"response.output_text.done","text":"answer"}\n\n`,
    `${prefix}[DONE]\n\n`,
  ].join("");

  test("accepts unspaced data frames", async () => {
    const spaced = await parseSidecarSSE(sseStream(frames("data: ")));
    const unspaced = await parseSidecarSSE(sseStream(frames("data:")));
    expect(spaced.text).toContain("answer");
    expect(unspaced.text).toBe(spaced.text);
  });
});
