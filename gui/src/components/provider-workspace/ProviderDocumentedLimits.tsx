/**
 * ProviderDocumentedLimits — renders a provider's DOCUMENTED rate limits
 * (from the provider's official docs) as reference text. Distinct from the
 * live utilization bars (ProviderCapacityQuota / QuotaBars): these numbers
 * are not probed, are tier-dependent, and can drift from reality.
 *
 * Component-only module (React Fast Refresh): the pure formatter/types live
 * in provider-workspace/documented-limits.ts.
 */
import type { TFn } from "../../i18n/shared";
import { formatDocumentedLimits, type DocumentedRateLimits } from "../../provider-workspace/documented-limits";

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
