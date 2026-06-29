/**
 * Antigravity (Cloud Code Assist) thoughtSignature reasoning-replay cache.
 *
 * Gemini-3 interleaved thinking is stateless upstream: each model content part carries a
 * `thoughtSignature` that MUST be echoed back on the matching part in the next request, or the
 * upstream rejects the turn (HTTP 400). We observe signatures on the response stream, cache them
 * per `model + session`, and re-inject them into the outgoing `request.contents` on the next turn.
 *
 * Mirrors CLIProxyAPI `internal/runtime/executor/antigravity_reasoning_replay.go`. Gemini-only;
 * Claude-on-Antigravity uses inline signature sanitization instead (see google-antigravity-wire).
 */

interface ThoughtSignatureItem {
  type: "thought_signature";
  contentIndex: number;
  partIndex: number;
  thoughtSignature: string;
}

interface ReplayEntry {
  items: ThoughtSignatureItem[];
  expiresAtMs: number;
}

const MIN_SIGNATURE_LEN = 16;
const REPLAY_TTL_MS = 60 * 60 * 1000; // 1h
const REPLAY_MAX_ENTRIES = 10_240;
const REPLAY_EVICT_BATCH = 128;

const replayCache = new Map<string, ReplayEntry>();

function replayKey(model: string, sessionId: string): string {
  return `${model}::session:${sessionId}`;
}

function extractSignature(part: Record<string, unknown>): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct.length >= MIN_SIGNATURE_LEN) return direct;
  const extra = part.extra_content as { google?: { thought_signature?: unknown } } | undefined;
  const nested = extra?.google?.thought_signature;
  if (typeof nested === "string" && nested.length >= MIN_SIGNATURE_LEN) return nested;
  return undefined;
}

function evictIfNeeded(): void {
  if (replayCache.size <= REPLAY_MAX_ENTRIES) return;
  const oldest = [...replayCache.entries()]
    .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)
    .slice(0, REPLAY_EVICT_BATCH);
  for (const [key] of oldest) replayCache.delete(key);
}

/** Gemini/Flash/Agent use the replay cache; Claude does not (inline sanitization instead). */
export function antigravityUsesReplayCache(model: string): boolean {
  return !/claude/i.test(model);
}

/**
 * Observe a parsed CCA chunk's `candidates[0].content.parts` and record any thought signatures,
 * keyed by model + session. `parts` is the already-unwrapped `response.candidates[0].content.parts`.
 */
export function observeAntigravityReplay(model: string, sessionId: string, parts: unknown[]): void {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts) || parts.length === 0) return;
  const found: ThoughtSignatureItem[] = [];
  parts.forEach((raw, partIndex) => {
    if (!raw || typeof raw !== "object") return;
    const sig = extractSignature(raw as Record<string, unknown>);
    if (sig) found.push({ type: "thought_signature", contentIndex: 0, partIndex, thoughtSignature: sig });
  });
  if (found.length === 0) return;
  const key = replayKey(model, sessionId);
  const existing = replayCache.get(key);
  // Merge by partIndex (latest wins), keep a single content slot (contentIndex 0 = the model turn).
  const byPart = new Map<number, ThoughtSignatureItem>();
  for (const item of existing?.items ?? []) byPart.set(item.partIndex, item);
  for (const item of found) byPart.set(item.partIndex, item);
  replayCache.set(key, { items: [...byPart.values()], expiresAtMs: Date.now() + REPLAY_TTL_MS });
  evictIfNeeded();
}

/**
 * Re-inject cached thought signatures into the outgoing `request.contents`. Only fills a part that
 * lacks a signature, and only when the indexed content/part exists. Returns the same array
 * reference (mutated in place) for convenience.
 */
export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
  const entry = replayCache.get(replayKey(model, sessionId));
  if (!entry || entry.expiresAtMs <= Date.now()) {
    if (entry) replayCache.delete(replayKey(model, sessionId));
    return contents;
  }
  // Re-inject onto the LAST model turn in contents (the most recent assistant content).
  const modelTurns = contents
    .map((c, i) => ({ c: c as { role?: string; parts?: unknown[] }, i }))
    .filter(({ c }) => c && typeof c === "object" && c.role === "model" && Array.isArray(c.parts));
  const target = modelTurns[modelTurns.length - 1];
  if (!target) return contents;
  const parts = target.c.parts as Record<string, unknown>[];
  for (const item of entry.items) {
    const part = parts[item.partIndex];
    if (part && typeof part === "object" && part.thoughtSignature === undefined && part.thought_signature === undefined) {
      part.thoughtSignature = item.thoughtSignature;
    }
  }
  return contents;
}

/** Drop the cache entry when upstream rejects a signature (clear-on-invalid). */
export function clearAntigravityReplay(model: string, sessionId: string): void {
  replayCache.delete(replayKey(model, sessionId));
}

/** Test seam. */
export function __resetAntigravityReplayCache(): void {
  replayCache.clear();
}
