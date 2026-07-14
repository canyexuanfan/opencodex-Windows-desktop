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
const LARGE_BURST_COUNT = 200;

let srv: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const requestedCount = Number(new URL(req.url).searchParams.get("count"));
      const count = Number.isSafeInteger(requestedCount) && requestedCount > 0 ? requestedCount : BURST_COUNT;
      const sseStream = bridgeToResponsesSSE(
        burstGenerator(count),
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
  async function collectTextDeltaStats(res: Response): Promise<{ count: number; groups: number; maxGroup: number }> {
    expect(res.ok).toBe(true);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const groups = new Map<number, number>();
    let readIndex = 0;
    let rawText = "";
    let count = 0;

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
        const dataLine = trimmed.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; delta?: string };
          if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
            count++;
            groups.set(readIndex, (groups.get(readIndex) ?? 0) + 1);
          }
        } catch {
        }
      }

      if (count >= LARGE_BURST_COUNT) break;
    }
    await reader.cancel();

    return { count, groups: groups.size, maxGroup: Math.max(...groups.values()) };
  }

  test(
    "text_delta events arrive across multiple reads, not coalesced into one end burst",
    async () => {
      const url = `http://127.0.0.1:${srv!.port}/stream`;

      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
      });

      const stats = await collectTextDeltaStats(res);

      expect(stats.count).toBe(BURST_COUNT);
      expect(stats.groups).toBeGreaterThan(1);
      expect(stats.maxGroup).toBeLessThanOrEqual(Math.ceil(BURST_COUNT * 0.75));
    },
    10_000,
  );

  test(
    "large synchronous replays complete within a bounded duration",
    async () => {
      const startedAt = performance.now();
      const res = await fetch(`http://127.0.0.1:${srv!.port}/stream?count=${LARGE_BURST_COUNT}`, {
        headers: { Accept: "text/event-stream" },
      });
      const stats = await collectTextDeltaStats(res);
      const elapsedMs = performance.now() - startedAt;

      expect(stats.count).toBe(LARGE_BURST_COUNT);
      expect(stats.groups).toBeGreaterThan(1);
      expect(elapsedMs).toBeLessThan(5_000);
    },
    10_000,
  );
});
