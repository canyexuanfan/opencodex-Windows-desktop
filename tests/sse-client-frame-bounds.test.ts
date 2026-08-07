import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  BoundedSseFrameBuffer,
  MAX_CLIENT_SSE_FRAME_BYTES,
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

  test("WebSocket pump emits one bounded protocol error for an oversized unterminated frame", async () => {
    const sent: string[] = [];
    const terminals: string[] = [];
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

    await pumpResponsesSseToWebSocket(ws, streamFromChunks([oversized]), {
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
    expect(ws.data.cancel).toBeUndefined();
  });
});
