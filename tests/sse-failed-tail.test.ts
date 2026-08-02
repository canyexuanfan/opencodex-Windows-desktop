import { describe, expect, test } from "bun:test";
import { relaySseWithFailedTail } from "../src/server";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sourceStream(chunks: string[], opts: { failAfter?: boolean; error?: Error } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      if (opts.failAfter) {
        controller.error(opts.error ?? Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }));
        return;
      }
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe("relaySseWithFailedTail", () => {
  test("relays a healthy stream verbatim with no injected frame", async () => {
    const upstream = new AbortController();
    const src = sourceStream(["event: response.completed\n", 'data: {"type":"response.completed"}\n\n', "data: [DONE]\n\n"]);
    const out = await drain(relaySseWithFailedTail(src, upstream));
    expect(out).toBe('event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
    expect(out).not.toContain("response.failed");
    expect(upstream.signal.aborted).toBe(false);
  });

  test("mid-stream error keeps prior bytes and appends a clean failed terminal", async () => {
    const upstream = new AbortController();
    const src = sourceStream(['data: {"type":"response.output_text.delta","delta":"hel', ""], { failAfter: true });
    const out = await drain(relaySseWithFailedTail(src, upstream));
    // Prior (partial) bytes preserved, then blank-line boundary, then the failed frame.
    expect(out.startsWith('data: {"type":"response.output_text.delta","delta":"hel')).toBe(true);
    expect(out).toContain("\n\nevent: response.failed\ndata: ");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    const dataLine = out.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!;
    const parsed = JSON.parse(dataLine) as { type: string; response: { status: string; error: { code: string; message: string } } };
    expect(parsed.type).toBe("response.failed");
    expect(parsed.response.status).toBe("failed");
    expect(parsed.response.error.code).toBe("upstream_reset");
    expect(parsed.response.error.message).toContain("socket connection was closed unexpectedly");
    // Stream CLOSED (drain returned) rather than erroring, and the upstream fetch was aborted.
    expect(upstream.signal.aborted).toBe(true);
  });

  test("error before any bytes yields only the failed terminal", async () => {
    const upstream = new AbortController();
    const src = sourceStream([], { failAfter: true });
    const out = await drain(relaySseWithFailedTail(src, upstream));
    expect(out).toContain("event: response.failed\ndata: ");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("client cancel aborts the upstream controller", async () => {
    const upstream = new AbortController();
    // A source that never ends on its own.
    const src = new ReadableStream<Uint8Array>({ pull() { /* stay pending */ } });
    const relayed = relaySseWithFailedTail(src, upstream);
    const reader = relayed.getReader();
    await reader.cancel(new DOMException("client closed", "AbortError"));
    expect(upstream.signal.aborted).toBe(true);
  });
});
