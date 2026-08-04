/**
 * Quota-aware policy scoring (RI-07).
 *
 * Evidence reuses the existing privacy-safe quota sources: the Codex pool
 * account quota cache (usage percents only - no emails, tokens, or raw
 * responses) and the provider per-account quota cache (Anthropic). Unknown
 * quota stays unknown; no raw quota response ever reaches a trace.
 *
 * Boundary: policy profiles select provider/model TARGETS. Exact account
 * selectors and Codex pool strategies remain authoritative inside their
 * existing scope; account-level quota evidence is consumed when a candidate
 * carries an account reference (dry-run/evaluate), never invented.
 */

import { getAccountQuota, isCodexQuotaExhausted } from "../codex/quota";
import { getCachedProviderAccountQuota } from "../providers/quota";
import type { RouteQuotaEvidence } from "./trace";

export interface QuotaEvidenceInput {
  provider: string;
  model: string;
  /** Opaque account reference for per-account quota sources. */
  accountRef?: string;
  /** Codex pool account id (provider "openai"). */
  codexAccountId?: string;
}

/**
 * Assemble quota evidence from canonical local caches only (no network).
 * Unknown dimensions stay unknown - never zero.
 */
export function quotaEvidenceForCandidate(input: QuotaEvidenceInput): RouteQuotaEvidence {
  if (input.provider === "openai" && input.codexAccountId) {
    const quota = getAccountQuota(input.codexAccountId);
    if (quota) {
      const percents = [quota.weeklyPercent, quota.monthlyPercent]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
      const resets = [quota.weeklyResetAt, quota.monthlyResetAt]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter(value => value > Date.now());
      return {
        known: true,
        ...(maxPercent !== undefined
          ? { headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)) }
          : {}),
        exhausted: isCodexQuotaExhausted(quota),
        ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
        source: "codex-pool",
      };
    }
  }

  if (input.provider === "anthropic" && input.accountRef) {
    const quota = getCachedProviderAccountQuota("anthropic", input.accountRef);
    if (quota) {
      const percents = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
      const resets = [quota.fiveHourResetAt, quota.weeklyResetAt, quota.monthlyResetAt]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter(value => value > Date.now());
      return {
        known: true,
        ...(maxPercent !== undefined
          ? { headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)) }
          : {}),
        exhausted: maxPercent !== undefined && maxPercent >= 100,
        ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
        source: "provider-report",
      };
    }
  }

  return { known: false };
}

/**
 * Deterministic quota score in [0,1]: larger available headroom scores
 * higher; exhausted evidence scores 0. Unknown evidence returns null so the
 * caller can apply the profile's unknownEvidence policy.
 */
export function quotaScore(evidence: RouteQuotaEvidence | undefined): number | null {
  if (!evidence || !evidence.known) return null;
  if (evidence.exhausted === true) return 0;
  if (typeof evidence.headroom === "number") return Math.max(0, Math.min(1, evidence.headroom));
  return null;
}
