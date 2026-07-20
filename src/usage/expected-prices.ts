/**
 * Expected-price overlay for models whose jawcode cost rows are missing or all-zero
 * (subscription/OAuth surfaces). Sourced from official pricing pages only
 * (devlog/_plan/260720_toks_speed_price_columns/003 — Luna research, main-verified).
 *
 * Status semantics:
 * - "verified": official page opened directly; the 4-tuple is the published API price.
 * - "verified-derived": mapped from a verified base-model price (for example an
 *   effort-suffix variant); propagates `estimated=true` downstream.
 * - "unverified": research lead only. NEVER registered here and never returned by
 *   the resolver — unverified prices live in the 003 §5 backlog until promoted.
 */

export interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ExpectedPriceStatus = "verified" | "verified-derived" | "unverified";

export interface ExpectedPriceOverlay {
  provider: string;
  modelId: string;
  cost4: Cost4;
  source: string;
  verifiedAt: string;
  status: ExpectedPriceStatus;
}

const GEMINI_31_PRO: Cost4 = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
const GEMINI_35_FLASH: Cost4 = { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 };
const GEMINI_3_FLASH: Cost4 = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 };
const MINIMAX_M21_HIGHSPEED: Cost4 = { input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 };

const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing (2026-06-18); cacheWrite=0: storage is billed per-hour, not per-token";
const MINIMAX_PRICING = "https://platform.minimax.io/docs/guides/pricing-paygo";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing-details-usd; V4 Flash alias transition scheduled 2026-07-24 — re-verify after";

export const EXPECTED_PRICE_OVERLAYS: readonly ExpectedPriceOverlay[] = [
  // MiniMax M2.1 highspeed — published PAYG price (verified).
  { provider: "minimax", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "minimax-cn", modelId: "MiniMax-M2.1-highspeed", cost4: MINIMAX_M21_HIGHSPEED, source: MINIMAX_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // DeepSeek current-generation IDs (verified; cache-hit price mapped to cacheRead).
  { provider: "deepseek", modelId: "deepseek-chat", cost4: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  { provider: "deepseek", modelId: "deepseek-reasoner", cost4: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }, source: DEEPSEEK_PRICING, verifiedAt: "2026-07-20", status: "verified" },
  // Google Antigravity effort-suffix variants — derived from the verified base-model
  // price (Google does not publish per-suffix prices; Agent inference bills at the
  // base model's standard rate per the official Billing FAQ).
  { provider: "google-antigravity", modelId: "gemini-3.1-pro-low", cost4: GEMINI_31_PRO, source: `derived: gemini-3.1-pro (<=200k tier) ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.1-pro-high", cost4: GEMINI_31_PRO, source: `derived: gemini-3.1-pro (<=200k tier) ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-extra-low", cost4: GEMINI_35_FLASH, source: `derived: gemini-3.5-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-low", cost4: GEMINI_35_FLASH, source: `derived: gemini-3.5-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-mid", cost4: GEMINI_35_FLASH, source: `derived: gemini-3.5-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3.5-flash-high", cost4: GEMINI_35_FLASH, source: `derived: gemini-3.5-flash ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
  { provider: "google-antigravity", modelId: "gemini-3-flash-agent", cost4: GEMINI_3_FLASH, source: `derived: gemini-3-flash + Agent billing principle ${GEMINI_PRICING}`, verifiedAt: "2026-07-20", status: "verified-derived" },
];

/**
 * Exact-key overlay lookup. Returns verified first, then verified-derived.
 * NEVER returns "unverified" rows — fail-closed is enforced in code, not just docs.
 * No fuzzy / case-fold / wire-model fallback.
 */
export function findExpectedPriceOverlay(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): ExpectedPriceOverlay | undefined {
  const exact = overlays.filter(row => row.provider === provider && row.modelId === modelId);
  return exact.find(row => row.status === "verified")
    ?? exact.find(row => row.status === "verified-derived");
}
