import { formatErrorResponse } from "../../bridge";
import { redactSecretString } from "../../lib/redact";

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an empty body to the literal client string "Unknown error"
 * (UnexpectedResponseError), which hid ChatGPT empty-503 failures behind
 * issue #452. Preserve OpenAI-style JSON that already has error.message;
 * otherwise wrap so the client always gets a non-empty message.
 */
export function formatPassthroughUpstreamError(status: number, bodyText: string): Response {
  const trimmed = bodyText.trim();
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as { error?: { message?: unknown } };
      const message = json?.error?.message;
      if (typeof message === "string" && message.trim().length > 0) {
        return new Response(trimmed, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch {
      /* non-JSON: wrap below */
    }
  }

  const detail = trimmed || "(empty body)";
  return formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: ${redactSecretString(detail.slice(0, 500))}`,
  );
}
