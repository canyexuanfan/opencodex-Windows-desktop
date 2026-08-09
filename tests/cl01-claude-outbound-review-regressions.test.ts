import { expect, test } from "bun:test";
import { responsesSseToAnthropicSse } from "../src/claude/outbound";
import { createTranslatorBudget } from "../src/lib/translator-budget";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

test("an initial Responses failure becomes one Anthropic error event without a synthetic message start", async () => {
  const frame = [
    "event: response.failed",
    'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"server_error","code":"overloaded","message":"fixture"}}}',
    "",
    "",
  ].join("\n");
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const budget = createTranslatorBudget();
  try {
    const anthropic = responsesSseToAnthropicSse(upstream, "fixture-model", {
      pingIntervalMs: 0,
      translatorBudget: budget,
    });
    const text = await collect(anthropic);
    const eventNames = text
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice("event: ".length));
    expect(eventNames).toEqual(["error"]);
  } finally {
    budget.dispose();
  }
});
