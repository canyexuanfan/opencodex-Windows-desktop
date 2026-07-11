/**
 * Request-body decompression for the /v1/responses data plane.
 *
 * Codex CLI compresses Responses HTTP bodies with zstd when its
 * `enable_request_compression` feature fires (default ON): auth is the codex
 * backend AND the provider is the built-in `openai` id (codex-rs client.rs
 * responses_request_compression). Under Design B injection the provider id IS
 * `openai`, so the HTTP fallback path (WebSocket unavailable) delivers
 * `content-encoding: zstd` bodies that `req.json()` cannot parse.
 */

/**
 * Cap decompressed request bodies (a compressed bomb must not inflate unbounded). Codex compresses
 * EVERY responses request with zstd (no size threshold), and image-heavy histories inflate fast:
 * ~12 full-res screenshots as base64 already cross 64MB decompressed. The proxy is fed by the user's
 * own local Codex over loopback, so the bomb threat is weak; this cap is really an OOM guard. Keep it
 * generous enough that ordinary multi-image sessions decode, while still bounding a runaway body.
 */
export const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;

export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export class DecompressedBodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Decompressed request body exceeds ${MAX_DECOMPRESSED_BODY_BYTES} bytes`);
  }
}

function assertBodySizeWithinLimit(body: Uint8Array): Uint8Array {
  if (body.byteLength > MAX_DECOMPRESSED_BODY_BYTES) throw new DecompressedBodyTooLargeError(body.byteLength);
  return body;
}

export function decodeRequestBody(raw: Uint8Array, contentEncoding: string | null): Uint8Array {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return assertBodySizeWithinLimit(raw);
  const compressed = raw as Uint8Array<ArrayBuffer>;
  let decoded: Uint8Array;
  if (encoding === "zstd") decoded = Bun.zstdDecompressSync(compressed);
  else if (encoding === "gzip" || encoding === "x-gzip") decoded = Bun.gunzipSync(compressed);
  else if (encoding === "deflate") decoded = Bun.inflateSync(compressed);
  // Multi-codings ("zstd, gzip") and unknown tokens are rejected rather than guessed.
  else throw new UnsupportedContentEncodingError(encoding);
  return assertBodySizeWithinLimit(decoded);
}

/** Parse a JSON request body, transparently decoding compressed payloads. */
export async function readJsonRequestBody(req: Request): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  const decoded = decodeRequestBody(new Uint8Array(await req.arrayBuffer()), encoding);
  return JSON.parse(new TextDecoder().decode(decoded));
}
