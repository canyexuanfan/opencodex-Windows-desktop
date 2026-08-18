/**
 * Whether a `done` event's `stopReason` means the turn was cut short rather than finishing.
 *
 * `stopReason` is an open-ended string and adapters do not agree on a vocabulary: openai-chat
 * normalizes to `max_tokens`/`content_filter`, Command Code forwards the raw provider value
 * (`length`), and Anthropic forwards `stop_reason` verbatim (`max_tokens`, `refusal`, ...).
 * Matching only the two canonical strings let a truncated turn read as completed — and, on a
 * compaction turn, install its half-written summary as replacement history (#422).
 *
 * Recognizing the vocabularies here keeps that guard from depending on which adapter produced
 * the event. Unknown reasons stay non-truncated: this must never turn a healthy turn into a
 * failure, and an unrecognized value is more likely a normal stop than a silent truncation.
 */
const TRUNCATED_STOP_REASONS = new Set([
  // canonical (openai-chat, google)
  "max_tokens",
  "content_filter",
  // raw OpenAI/Command Code finish reasons
  "length",
  // raw Anthropic stop reasons
  "max_output_tokens",
  "refusal",
  // raw Gemini/Vertex finish reasons
  "MAX_TOKENS",
  "MALFORMED_FUNCTION_CALL",
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export function isTruncatedStopReason(stopReason: string | undefined): boolean {
  if (stopReason === undefined) return false;
  const trimmed = stopReason.trim();
  return TRUNCATED_STOP_REASONS.has(trimmed) || TRUNCATED_STOP_REASONS.has(trimmed.toLowerCase());
}
