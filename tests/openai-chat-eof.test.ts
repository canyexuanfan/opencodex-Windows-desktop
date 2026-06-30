import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("openai-chat stream EOF fail-closed", () => {
  test("truncated stream (no [DONE], no finish_reason) yields a terminal error, not a clean done", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("clean [DONE] yields done", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("EOF after a finish_reason (provider omits [DONE]) is accepted as done", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("inline error envelope still yields a terminal error (no regression)", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"Rate limit reached for model","code":"rate_limit_exceeded"}}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "Rate limit reached for model" });
  });

  test("finish-only chunk with no delta (provider omits [DONE]) is accepted as done", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("final finish_reason frame WITHOUT a trailing newline is accepted as done (not falsely failed)", async () => {
    // No trailing "\n" — the terminal frame stays in the buffer and is only seen at EOF.
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("final usage-only frame without a trailing newline is accepted as done", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("genuinely truncated stream WITHOUT a trailing newline still fails closed", async () => {
    // Mid-content frame, no terminator, no newline — must remain a terminal error.
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});
