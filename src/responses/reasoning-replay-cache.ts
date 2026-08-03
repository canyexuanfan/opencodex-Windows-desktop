/**
 * In-process fallback store pairing raw reasoning text with the tool call it
 * preceded (issue #950).
 *
 * DeepSeek thinking mode requires the assistant's original `reasoning_content`
 * to be replayed on every continuation of a tool-call turn. The bridge records
 * the raw reasoning here when it closes a reasoning block and a tool call
 * follows; the openai-chat adapter re-attaches it when a `tool_calls`
 * assistant message is about to serialize without thinking parts (compacted
 * history, lost assistant turn, orphan-repaired tool results).
 *
 * Privacy: entries hold reasoning text in memory only — never logged,
 * serialized, or exported. Bounded by entry count, total bytes, and TTL, so a
 * long-lived proxy cannot grow without limit.
 */

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 256 * 1024;
const TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  text: string;
  bytes: number;
  at: number;
}

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;
let clockForTests: (() => number) | null = null;

const now = (): number => clockForTests?.() ?? Date.now();

/** Record the raw reasoning text that preceded the given tool call. */
export function rememberReasoningForCall(callId: string, text: string): void {
  if (!callId || typeof text !== "string" || text.length === 0) return;
  const bytes = Buffer.byteLength(text, "utf8");
  // A single entry larger than the whole budget would immediately evict itself.
  if (bytes > MAX_TOTAL_BYTES) return;
  const at = now();
  const previous = entries.get(callId);
  if (previous) totalBytes -= previous.bytes;
  entries.set(callId, { text, bytes, at });
  totalBytes += bytes;
  // Evict oldest-first until both caps hold (never evict the entry just written
  // while it is the only one — the loop guards on size > 1).
  while ((totalBytes > MAX_TOTAL_BYTES || entries.size > MAX_ENTRIES) && entries.size > 1) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    const evicted = entries.get(oldestKey)!;
    totalBytes -= evicted.bytes;
    entries.delete(oldestKey);
  }
}

/**
 * Read the recorded reasoning for a call id without removing it: retries after
 * a failed continuation reuse the same fallback.
 */
export function peekReasoningForCall(callId: string): string | undefined {
  if (!callId) return undefined;
  const entry = entries.get(callId);
  if (!entry) return undefined;
  if (now() - entry.at > TTL_MS) {
    entries.delete(callId);
    totalBytes -= entry.bytes;
    return undefined;
  }
  return entry.text;
}

/** Test-only: reset the cache and optionally pin the clock. */
export function clearReasoningReplayCacheForTests(clock?: (() => number) | null): void {
  entries.clear();
  totalBytes = 0;
  clockForTests = clock ?? null;
}
