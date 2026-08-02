import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithHeaderTimeout } from "../src/server/responses";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startHeaderEchoServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new Response(req.headers.get("accept-encoding") ?? "");
    },
  });
  servers.push(server);
  return server;
}

async function observedEncoding(headers: HeadersInit | undefined, streaming: boolean): Promise<string> {
  const server = startHeaderEchoServer();
  const response = await fetchWithHeaderTimeout(
    server.url.toString(),
    { headers },
    new AbortController().signal,
    1_000,
    streaming,
  );
  return response.text();
}

function delayedSseStream(delayMs = 80): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      setTimeout(() => {
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      }, delayMs);
    },
  });
}

function startCompressionAwareSseServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const acceptsGzip = req.headers.get("accept-encoding")?.includes("gzip") === true;
      const body = acceptsGzip
        ? delayedSseStream().pipeThrough(new CompressionStream("gzip"))
        : delayedSseStream();
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          ...(acceptsGzip ? { "content-encoding": "gzip" } : {}),
        },
      });
    },
  });
  servers.push(server);
  return server;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return new TextDecoder().decode(chunk.value);
}

describe("fetchWithHeaderTimeout content-encoding policy", () => {
  test("streaming defaults to identity while non-streaming keeps Bun negotiation", async () => {
    expect(await observedEncoding(undefined, true)).toBe("identity");
    const nonStreaming = await observedEncoding(undefined, false);
    expect(nonStreaming).toContain("gzip");
    expect(nonStreaming).not.toBe("identity");
  });

  test("explicit caller encoding wins for every HeadersInit shape", async () => {
    expect(await observedEncoding({ "Accept-Encoding": "gzip" }, true)).toBe("gzip");
    expect(await observedEncoding([["aCcEpT-EnCoDiNg", "br"]], true)).toBe("br");
    expect(await observedEncoding(new Headers({ "ACCEPT-ENCODING": "deflate" }), true)).toBe("deflate");
  });

  test("identity keeps SSE frames incremental instead of waiting for a gzip block", async () => {
    const server = startCompressionAwareSseServer();

    const compressed = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      false,
    );
    const compressedReader = compressed.body!.getReader();
    expect(await readChunk(compressedReader)).toBe("data: first\n\ndata: second\n\n");

    const identity = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      true,
    );
    const identityReader = identity.body!.getReader();
    expect(await readChunk(identityReader)).toBe("data: first\n\n");
    expect(await readChunk(identityReader)).toBe("data: second\n\n");
  });
});
