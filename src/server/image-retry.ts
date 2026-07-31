/**
 * Upstream-413 tightened-retry gate (devlog/260714_image_normalization_pipeline/030).
 *
 * When Anthropic still rejects a normalized request with 413 request_too_large (budget
 * estimate missed: giant text share, tool schemas, ...), the proxy rebuilds the SAME
 * request with `imageTierBias: 1` — every image one ladder position lower — and retries
 * exactly once. The decision logic lives here so it is unit-testable; the fetch loop in
 * responses.ts consumes it.
 */

import type { OcxParsedRequest } from "../types";

/** True when the parsed request carries at least one inline (data-URL) image. */
export function parsedHasInlineImage(parsed: OcxParsedRequest): boolean {
  const messages = (parsed as { context?: { messages?: unknown[] } }).context?.messages ?? [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const imageUrl = (part as { imageUrl?: unknown })?.imageUrl;
      if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) return true;
    }
  }
  return false;
}

/**
 * One tier-biased rebuild per request (spiral guard), only for the anthropic adapter
 * (others ignore imageTierBias — an identical retry would just duplicate cost), and only
 * when the request actually carries inline images the bias can shrink.
 */
export function shouldAttemptImageTierRetry(args: {
  status: number;
  adapterName: string;
  parsed: OcxParsedRequest;
  alreadyAttempted: boolean;
}): boolean {
  return args.status === 413
    && !args.alreadyAttempted
    && args.adapterName === "anthropic"
    && parsedHasInlineImage(args.parsed);
}
