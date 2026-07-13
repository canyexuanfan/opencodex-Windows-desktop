import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* burstGenerator(count: number): AsyncGenerator<AdapterEvent> {
  for (let i = 0; i < count; i++) {
    yield { type: "text_delta", text: `chunk-${i} ` } as AdapterEvent;
  }
  yield { type: "done" } as AdapterEvent;
}

const BURST_COUNT = 40;

let srv: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(_req) {
      const sseStream = bridgeToResponsesSSE(
        burstGenerator(BURST_COUNT),
        "test/model",
      );
      return new Response(sseStream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
});

afterEach(() => {
  srv?.stop(true);
  srv = null;
});

describe("bridge live SSE delivery (issue #114 coalescing regression)", () => {
  test(
    "text_delta events arrive across multiple reads, not coalesced into one end burst",
    async () => {
      const url = `http://127.0.0.1:${srv!.port}/stream`;

      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.ok).toBe(true);
      expect(res.body).not.toBeNull();

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const deliveries: number[] = [];
      let readIndex = 0;
      let rawText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        readIndex++;

        const frames = rawText.split("\n\n");
        rawText = frames.pop() ?? "";

        for (const frame of frames) {
          const trimmed = frame.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          const dataLine = trimmed.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; delta?: string };
            if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
              deliveries.push(readIndex);
            }
          } catch {
          }
        }

        if (deliveries.length >= BURST_COUNT) break;
      }
      await reader.cancel();

      expect(deliveries.length).toBe(BURST_COUNT);

      expect(new Set(deliveries).size).toBeGreaterThan(1);
    },
    10_000,
  );
});
