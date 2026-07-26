/**
 * Best-effort chat/session correlation for Logs / usage.jsonl (#330).
 * Opaque ids only — never persist raw emails or Claude Desktop system-hash fallbacks.
 */
import { createHash } from "node:crypto";

export const LOG_CONVERSATION_ID_MAX = 128;

/** Cap / sanitize a correlation id for persistence. Returns undefined when unusable. */
export function normalizeLogConversationId(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Reject control characters that would break JSONL / UI paste.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (trimmed.length <= LOG_CONVERSATION_ID_MAX) return trimmed;
  // Long opaque tokens (e.g. full Cursor ids) hash to a stable short key so filters stay pasteable.
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}

/**
 * Codex/Claude/Cursor priority for Responses-shaped requests:
 * parent thread header > session_id > thread-id > cursor conversation id.
 */
export function conversationIdFromResponsesRequest(input: {
  clientThreadId?: string;
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  cursorConversationId?: string;
}): string | undefined {
  return normalizeLogConversationId(
    input.clientThreadId
      ?? input.sessionIdHeader
      ?? input.threadIdHeader
      ?? input.cursorConversationId,
  );
}

/** Claude Code metadata-derived prompt_cache_key only — never the system-hash Desktop fallback. */
export function conversationIdFromClaudeCacheKey(
  cacheKeySource: "metadata" | "system" | null | undefined,
  promptCacheKey: string | undefined,
): string | undefined {
  if (cacheKeySource !== "metadata") return undefined;
  return normalizeLogConversationId(promptCacheKey);
}

export interface ConversationLogTotals {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

type TotalsSource = {
  totalTokens?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  usageStatus?: string;
  displayMetrics?: {
    cost?:
      | { kind: "value"; estimate: { cost: { total: number } } }
      | { kind: "unavailable"; reason: string };
  };
};

function rowTokenTotal(entry: TotalsSource): number | undefined {
  if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens) && entry.totalTokens >= 0) {
    return entry.totalTokens;
  }
  const usageTotal = entry.usage?.totalTokens;
  if (typeof usageTotal === "number" && Number.isFinite(usageTotal) && usageTotal >= 0) return usageTotal;
  const input = entry.usage?.inputTokens;
  const output = entry.usage?.outputTokens;
  if (typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output)) {
    return Math.max(0, input) + Math.max(0, output);
  }
  return undefined;
}

/** Sum tokens/cost for the currently loaded log slice matching a conversation filter. */
export function summarizeConversationLogs(entries: readonly TotalsSource[]): ConversationLogTotals {
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    const tokens = rowTokenTotal(entry);
    if (tokens !== undefined) totalTokens += tokens;
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    if (cost?.kind === "value" && Number.isFinite(cost.estimate.cost.total) && cost.estimate.cost.total >= 0) {
      estimatedCostUsd += cost.estimate.cost.total;
      pricedRequests += 1;
      continue;
    }
    unpricedRequests += 1;
  }
  return {
    requests: entries.length,
    totalTokens,
    estimatedCostUsd,
    pricedRequests,
    unpricedRequests,
    unmeteredRequests,
  };
}
