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

export function formatDocumentedLimits(rateLimits: DocumentedRateLimits, t: TFn): string {
  const parts: string[] = [];
  if (rateLimits.rpm !== undefined) parts.push(t("pws.rateLimits.rpm", { value: formatNumber(rateLimits.rpm) }));
  if (rateLimits.tpm !== undefined) parts.push(t("pws.rateLimits.tpm", { value: formatNumber(rateLimits.tpm) }));
  if (rateLimits.rpd !== undefined) parts.push(t("pws.rateLimits.rpd", { value: formatNumber(rateLimits.rpd) }));
  if (rateLimits.freeTier) parts.push(rateLimits.freeTier);
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
