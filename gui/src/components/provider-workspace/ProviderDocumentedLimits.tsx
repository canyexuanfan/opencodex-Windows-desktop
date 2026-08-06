/**
 * ProviderDocumentedLimits — renders a provider's DOCUMENTED rate limits
 * (from the provider's official docs) as reference text. Distinct from the
 * live utilization bars (ProviderCapacityQuota / QuotaBars): these numbers
 * are not probed, are tier-dependent, and can drift from reality.
 */
import type { TFn } from "../../i18n/shared";

export interface DocumentedRateLimits {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  freeTier?: string;
  source?: string;
  updatedAt?: string;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(value);
}

/**
 * Map a known free-tier description to a localizable i18n key. Registry
 * `freeTier` prose is English-authored backend data; rendering it verbatim
 * leaves non-English locales with a partially-English row. Unknown strings
 * fall back to the raw prose.
 */
const FREE_TIER_KEYS: Record<string, string> = {
  "Local — no remote limits": "pws.rateLimits.freeTier.local",
  "~200 free-model requests per 5 hours": "pws.rateLimits.freeTier.opencodeFree",
  "Free tier: ~15 RPM / 250K TPM / 1K RPD (tier-dependent)": "pws.rateLimits.freeTier.gemini",
  "Free tier: ~30 RPM / 6K TPM / 1K RPD": "pws.rateLimits.freeTier.groq",
  "Free tier: ~60 RPM / 100K TPM; then pay-as-you-go": "pws.rateLimits.freeTier.sambanova",
  "Free tier: ~50 RPM / 50K TPM": "pws.rateLimits.freeTier.nebius",
  "Free tier: ~5 RPM / 20K TPM; then pay-as-you-go": "pws.rateLimits.freeTier.mistral",
  "Free tier: ~60 RPM / 1M TPM; then pay-as-you-go": "pws.rateLimits.freeTier.together",
  "Free tier: ~600 RPM / 150K TPM": "pws.rateLimits.freeTier.fireworks",
  "Free models: ~20 req/min, credit-capped; paid per model": "pws.rateLimits.freeTier.openrouter",
  "Coding plan subscription; per-plan quotas": "pws.rateLimits.freeTier.minimax",
  "GLM coding subscription (paid plan)": "pws.rateLimits.freeTier.zai",
  "New accounts: one-time token grant; then pay-as-you-go": "pws.rateLimits.freeTier.deepseek",
};

function localizeFreeTier(freeTier: string, t: TFn): string {
  const key = FREE_TIER_KEYS[freeTier];
  return key ? t(key as never) : freeTier;
}

export function formatDocumentedLimits(rateLimits: DocumentedRateLimits, t: TFn): string {
  const parts: string[] = [];
  if (rateLimits.rpm !== undefined) parts.push(t("pws.rateLimits.rpm", { value: formatNumber(rateLimits.rpm) }));
  if (rateLimits.tpm !== undefined) parts.push(t("pws.rateLimits.tpm", { value: formatNumber(rateLimits.tpm) }));
  if (rateLimits.rpd !== undefined) parts.push(t("pws.rateLimits.rpd", { value: formatNumber(rateLimits.rpd) }));
  if (rateLimits.freeTier) parts.push(localizeFreeTier(rateLimits.freeTier, t));
  return parts.join(" · ");
}

export function ProviderDocumentedLimits({ rateLimits, t }: { rateLimits: DocumentedRateLimits; t: TFn }) {
  const summary = formatDocumentedLimits(rateLimits, t);
  if (!summary) return null;
  return (
    <div className="pws-documented-limits">
      <span className="pws-documented-limits-label">{t("pws.rateLimits.documented")}</span>
      <span className="pws-documented-limits-value">{summary}</span>
      {(rateLimits.source || rateLimits.updatedAt) && (
        <span className="muted pws-documented-limits-meta">
          {[rateLimits.updatedAt, rateLimits.source].filter(Boolean).join(" · ")}
        </span>
      )}
    </div>
  );
}
