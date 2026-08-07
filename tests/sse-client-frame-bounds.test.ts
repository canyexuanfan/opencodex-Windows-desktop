import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  BoundedSseFrameBuffer,
  MAX_CLIENT_SSE_FRAME_BYTES,
  SseFrameCountLimitError,
  SseFrameTooLargeError,
} from "../src/server/sse-frame-buffer";
import { relaySseWithFailedTail } from "../src/server/relay";
import { pumpResponsesSseToWebSocket, type WsData } from "../src/server/ws-bridge";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

describe("client-facing SSE frame bounds", () => {
  test("the byte framer accepts the exact cap and preserves a split delimiter", () => {
    const framer = new BoundedSseFrameBuffer(8);

    expect(framer.feed(enc.encode("1234"))).toEqual([]);
    expect(framer.feed(enc.encode("5678\n"))).toEqual([]);
    const frames = framer.feed(enc.encode("\n"));

    expect(frames).toHaveLength(1);
    expect(dec.decode(frames[0]!.block)).toBe("12345678");
    expect(dec.decode(frames[0]!.delimiter)).toBe("\n\n");
    expect(framer.finish().byteLength).toBe(0);
  });

  test("the byte framer rejects cap + 1 without retaining an oversized tail", () => {
    const framer = new BoundedSseFrameBuffer(8);

    expect(() => framer.feed(enc.encode("123456789"))).toThrow(SseFrameTooLargeError);
    expect(framer.finish().byteLength).toBe(0);
  });

  test("delimiter-only input cannot amplify one chunk into unbounded frame objects", () => {
    const framer = new BoundedSseFrameBuffer(4096);

    expect(() => framer.feed(enc.encode("\n\n".repeat(5)))).toThrow(SseFrameCountLimitError);
    expect(framer.finish().byteLength).toBe(0);
  });

  test("fragmented multibyte UTF-8 is decoded only after the complete frame arrives", () => {
    const text = 'data: {"type":"response.created","label":"€"}';
    const bytes = enc.encode(text);
    const euro = enc.encode("€");
    const euroStart = bytes.findIndex((value, index) => (
      value === euro[0]
      && bytes[index + 1] === euro[1]
      && bytes[index + 2] === euro[2]
    ));
    expect(euroStart).toBeGreaterThan(0);

    const framer = new BoundedSseFrameBuffer(1024);
    expect(framer.feed(bytes.slice(0, euroStart + 1))).toEqual([]);
    const remainder = bytes.slice(euroStart + 1);
    const delimiter = enc.encode("\n\n");
    const secondChunk = new Uint8Array(remainder.byteLength + delimiter.byteLength);
    secondChunk.set(remainder, 0);
    secondChunk.set(delimiter, remainder.byteLength);
    const frames = framer.feed(secondChunk);

    expect(frames).toHaveLength(1);
    expect(dec.decode(frames[0]!.block)).toBe(text);
  });

  test("HTTP native relay fails closed instead of retaining an oversized unterminated frame", async () => {
    const upstream = new AbortController();
    const oversized = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1);
    oversized.fill(120);
    const relayed = relaySseWithFailedTail(streamFromChunks([oversized]), upstream);

    const text = await new Response(relayed).text();

    expect(text.length).toBeLessThan(2048);
    expect(text).toContain("response.failed");
    expect(text).toContain(`upstream SSE frame exceeded ${MAX_CLIENT_SSE_FRAME_BYTES} bytes`);
    expect(text).toContain("data: [DONE]");
    expect(upstream.signal.aborted).toBe(true);
  });

  test("HTTP failed-tail cleanup preserves the original failure when finish also overflows", async () => {
    const upstream = new AbortController();
    const nearCapWithAmbiguousTail = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1);
    nearCapWithAmbiguousTail.fill(120, 0, MAX_CLIENT_SSE_FRAME_BYTES);
    nearCapWithAmbiguousTail[MAX_CLIENT_SSE_FRAME_BYTES] = 10;
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(nearCapWithAmbiguousTail);
          return;
        }
        controller.error(new Error("socket reset after partial frame"));
      },
    });
    const relayed = relaySseWithFailedTail(source, upstream);

    const text = await new Response(relayed).text();

    expect(text.length).toBeLessThan(2048);
    expect(text).toContain("response.failed");
    expect(text).toContain("socket reset after partial frame");
    expect(text).toContain("data: [DONE]");
    expect(upstream.signal.aborted).toBe(true);
  });

  test("WebSocket pump emits one bounded protocol error and cancels upstream on overflow", async () => {
    const sent: string[] = [];
    const terminals: string[] = [];
    let sourceCancelled = false;
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send(message: string) {
        sent.push(message);
        return 1;
      },
    } as unknown as ServerWebSocket<WsData>;
    const oversized = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1);
    oversized.fill(120);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    await pumpResponsesSseToWebSocket(ws, source, {
      onTerminal: status => terminals.push(status),
    });

    expect(terminals).toEqual(["incomplete"]);
    expect(sent).toHaveLength(1);
    const error = JSON.parse(sent[0]!) as {
      type?: string;
      status?: number;
      error?: { code?: string; message?: string };
    };
    expect(error.type).toBe("error");
    expect(error.status).toBe(502);
    expect(error.error?.code).toBe("websocket_protocol_error");
    expect(error.error?.message).toBe(
      `upstream SSE frame exceeded ${MAX_CLIENT_SSE_FRAME_BYTES} bytes`,
    );
    expect(sourceCancelled).toBe(true);
    expect(ws.data.cancel).toBeUndefined();
  });

  test("WebSocket send drops do not trigger a second failing protocol-error send", async () => {
    let sourceCancelled = false;
    let sendCalls = 0;
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send() {
        sendCalls += 1;
        return 0;
      },
    } as unknown as ServerWebSocket<WsData>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"response.created"}\n\n'));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    await expect(pumpResponsesSseToWebSocket(ws, source)).resolves.toBeUndefined();

    expect(sendCalls).toBe(1);
    expect(sourceCancelled).toBe(true);
    expect(ws.data.cancel).toBeUndefined();
  });
});
