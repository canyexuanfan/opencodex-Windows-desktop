export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
  const text = message.toLowerCase();
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (type === "origin_rejected") {
    return { message, type: "invalid_request_error", code: "origin_rejected" };
  }
  if (status === 401 || status === 403 || type === "authentication_error") {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}
