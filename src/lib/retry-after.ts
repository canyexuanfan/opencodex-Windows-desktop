import { parseRetryAfterMs } from "../combos";
import { classifyError, parseRetryAfterFromMessage } from "./errors";

/** Small default when a retryable 429 has no upstream Retry-After (#507). */
export const DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC = "2";

function sanitizedRetryAfterHeader(value: string | null | undefined, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}

/**
 * Pick a Retry-After value that clients (especially Codex) can back off on.
 *
 * Order: validated upstream header → delay embedded in the error message →
 * small default for retryable rate-limit 429s. Quota-exhausted 429s get no
 * default — hammering a spent quota is not a backoff problem.
 */
export function resolveClientRetryAfter(opts: {
  status: number;
  message?: string;
  upstreamRetryAfter?: string | null;
  now?: number;
}): string | undefined {
  const now = opts.now ?? Date.now();
  const fromHeader = sanitizedRetryAfterHeader(opts.upstreamRetryAfter, now);
  if (fromHeader) return fromHeader;

  const message = opts.message ?? "";
  const fromMessage = parseRetryAfterFromMessage(message);
  if (fromMessage !== undefined) return String(fromMessage);

  if (opts.status !== 429) return undefined;
  const classified = classifyError(429, "rate_limit_error", message || "Too Many Requests");
  if (classified.type === "insufficient_quota" || classified.code === "insufficient_quota") {
    return undefined;
  }
  return DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC;
}
