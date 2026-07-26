import { formatErrorResponse } from "../../bridge";
import { resolveClientRetryAfter } from "../../lib/retry-after";

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) must keep their original bytes and headers so pool-retry
 * activation and client diagnostics stay honest.
 *
 * When Retry-After is missing on a retryable 429, inject a small default so
 * Codex/Responses clients can back off the same way Claude Code does (#507).
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
  },
): Response {
  const trimmed = bodyText.trim();
  const now = options?.now ?? Date.now();
  const retryAfter = resolveClientRetryAfter({
    status,
    message: trimmed || `Provider error ${status}: (empty body)`,
    upstreamRetryAfter: options?.headers?.get("retry-after"),
    now,
  });

  if (trimmed) {
    if (retryAfter && !options?.headers?.get("retry-after")?.trim()) {
      const headers = options?.headers
        ? new Headers(options.headers)
        : new Headers({ "Content-Type": "application/json" });
      headers.set("Retry-After", retryAfter);
      return new Response(bodyText, {
        status,
        ...(options?.statusText ? { statusText: options.statusText } : {}),
        headers,
      });
    }
    return new Response(bodyText, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
      ...(options?.headers ? { headers: options.headers } : { headers: { "Content-Type": "application/json" } }),
    });
  }

  const response = formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
    retryAfter !== undefined ? { retryAfter } : undefined,
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return new Response(response.body, { status: response.status, headers });
}
