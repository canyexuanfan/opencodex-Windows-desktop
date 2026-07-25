import { formatErrorResponse } from "../../bridge";

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) must keep their original bytes and headers so pool-retry
 * activation and client diagnostics stay honest.
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
  },
): Response {
  const trimmed = bodyText.trim();
  if (trimmed) {
    return new Response(bodyText, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
      ...(options?.headers ? { headers: options.headers } : { headers: { "Content-Type": "application/json" } }),
    });
  }

  return formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
  );
}
