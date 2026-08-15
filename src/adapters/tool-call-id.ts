import { createHash } from "node:crypto";

/**
 * Normalize a tool call id into the character set Anthropic accepts.
 *
 * Anthropic validates `tool_use.id` against `[a-zA-Z0-9_-]`, so non-conforming characters are mapped
 * to `_`. To keep the mapping injective (so two distinct raw ids like `call:a` and `call/a` cannot
 * collide into one `tool_use.id` within a request), a short hash of the original raw id is appended
 * whenever any character had to be rewritten. The transform is deterministic, so a call id and its
 * matching result id — equal at the source, since the client pairs them — still normalize identically
 * and the call/result pairing is preserved. Returns `undefined` for an empty id so the caller can omit
 * the field entirely rather than inventing a non-matching one.
 *
 * Ids that already conform are returned unchanged, which is the common case: ids minted by Anthropic
 * itself round-trip untouched.
 */
export function anthropicToolCallId(rawId: string | undefined): string | undefined {
  const raw = rawId ?? "";
  if (raw.length === 0) return undefined;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === raw) return cleaned;
  // Lossy rewrite happened: disambiguate with a deterministic suffix derived from the raw id.
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${cleaned}_${suffix}`;
}
