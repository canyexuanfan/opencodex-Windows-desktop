import { formatErrorResponse } from "../../bridge";
import { parseRetryAfterMs } from "../../combos";

function sanitizedRetryAfter(value: string | null | undefined, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) must keep their original bytes and headers so pool-retry
 * activation and client diagnostics stay honest.
 *
 * Normalized (empty-body) responses force `Content-Type: application/json` and
 * preserve a validated `Retry-After` so Responses clients and the chat-completions
 * / Claude bridges that copy that header keep correct backoff.
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
  const retryAfter = sanitizedRetryAfter(options?.headers?.get("retry-after"), now);

  if (trimmed) {
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
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return new Response(response.body, { status: response.status, headers });
}
