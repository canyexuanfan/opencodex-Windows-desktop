/**
 * OpenCode Zen short-window rate-limit guidance (#1145 / OCX-56).
 *
 * OpenCode's keyed and keyless Zen chat endpoints share `https://opencode.ai/zen/v1`
 * and return opaque `429 Rate limit exceeded` bodies without `Retry-After` or
 * `X-RateLimit-*` headers. Community request logs show a burst ceiling around
 * 15–20 requests/minute on free models — distinct from the keyless desktop
 * ~200 requests / 5h quota documented on `opencode-free`.
 */
import { registryEntryForProviderDestination } from "./registry";

const OPENCODE_ZEN_PROVIDER_IDS = new Set(["opencode-zen", "opencode-free"]);

/** Observed free-model burst ceiling on Zen (not an official OpenCode figure). */
export const OPENCODE_ZEN_OBSERVED_RPM_HINT = "roughly 15-20 requests per minute";

/**
 * Synthetic client backoff when Zen omits Retry-After after a rate-limit 429.
 * Longer than the generic 2s default so Codex-shaped clients do not immediately
 * re-hammer a ~15-20 RPM window.
 */
export const OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC = 15;

const ENRICHMENT_MARKER = "15-20 requests per minute";

export function isOpenCodeZenRateLimitProvider(opts: {
  providerName?: string;
  baseUrl?: string;
  adapter?: string;
}): boolean {
  const name = opts.providerName?.trim();
  if (name && OPENCODE_ZEN_PROVIDER_IDS.has(name)) return true;
  const baseUrl = opts.baseUrl?.trim();
  if (!baseUrl) return false;
  const entry = registryEntryForProviderDestination({
    baseUrl,
    adapter: opts.adapter?.trim() || "openai-chat",
    authMode: "key",
  });
  return entry !== undefined && OPENCODE_ZEN_PROVIDER_IDS.has(entry.id);
}

/**
 * Append actionable Zen rate-limit context to a generic upstream 429 message and
 * embed a parseable `try again in Ns` hint so {@link resolveClientRetryAfter}
 * surfaces a useful Retry-After when the gateway sent none.
 */
export function enrichOpenCodeZenRateLimitMessage(
  message: string,
  opts: {
    status: number;
    providerName?: string;
    baseUrl?: string;
    adapter?: string;
  },
): string {
  if (opts.status !== 429) return message;
  if (!isOpenCodeZenRateLimitProvider(opts)) return message;
  if (!/rate\s*limit/i.test(message)) return message;
  if (message.includes(ENRICHMENT_MARKER)) return message;

  const retryHint = /try again in \d/i.test(message)
    ? ""
    : ` Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s.`;
  return (
    `${message}`
    + ` OpenCode Zen free-model traffic is often limited to ${OPENCODE_ZEN_OBSERVED_RPM_HINT}`
    + ` (observed; OpenCode does not publish this RPM or rate-limit headers).`
    + `${retryHint}`
    + " Slow the request pace, or set providers.opencode-zen.retryOn429 for same-key backoff."
  );
}
