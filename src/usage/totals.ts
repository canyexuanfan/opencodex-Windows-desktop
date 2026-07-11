import type { OcxUsage } from "../types";

/**
 * Canonical display total (devlog 070): `inputTokens` is already INCLUSIVE of cache
 * read/write, so the total is simply input+output. Cache detail is never re-added —
 * that was the 2x inflation bug on cache-heavy Claude rows. `Math.max` keeps legacy
 * persisted rows (pre-070 exclusive input) honest via their stored explicit total.
 */
export function usageDisplayTotalTokens(usage: OcxUsage | undefined, storedTotal?: number): number | undefined {
  if (!usage) return storedTotal;
  const baseTotal = usage.inputTokens + usage.outputTokens;
  const explicitTotal = usage.totalTokens ?? storedTotal;
  return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
}
