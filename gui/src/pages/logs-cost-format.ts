import type { TFn } from "../i18n/shared";
import { cachedNumberFormat } from "../intl-formatters";

export function formatEstimatedUsdTotal(
  totalUsd: number | undefined,
  lowerBound: boolean,
  localeTag: string | undefined,
  t: TFn,
): string {
  if (totalUsd === undefined || !Number.isFinite(totalUsd) || totalUsd < 0) {
    return t("logs.cost.unavailable");
  }
  const amount = cachedNumberFormat(localeTag, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(totalUsd);
  return t(lowerBound ? "logs.cost.lowerBound" : "logs.cost.approximate", { amount });
}

export interface LogCostSummaryEntry {
  usageStatus?: string;
  displayMetrics?: {
    cost?:
      | {
        kind: "value";
        estimate: { cost: { total: number } };
        estimateReasons: readonly string[];
      }
      | { kind: "unavailable" };
  };
}

export interface EstimatedCostSummary {
  estimatedCostUsd: number;
  priorityLowerBound: boolean;
  unpricedRequests: number;
  unmeteredRequests: number;
}

/** Sum valid displayed costs without upgrading a mixed estimate into a known lower bound. */
export function summarizeEstimatedCosts(entries: readonly LogCostSummaryEntry[]): EstimatedCostSummary {
  let estimatedCostUsd = 0;
  let pricedEstimates = 0;
  let everyPricedEstimateIsLowerBound = true;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    if (cost?.kind === "value") {
      const total = cost.estimate.cost.total;
      if (Number.isFinite(total) && total >= 0) {
        estimatedCostUsd += total;
        pricedEstimates += 1;
        everyPricedEstimateIsLowerBound &&= cost.estimateReasons.includes("priority_lower_bound");
        continue;
      }
    }
    unpricedRequests += 1;
  }
  return {
    estimatedCostUsd,
    priorityLowerBound: pricedEstimates > 0 && everyPricedEstimateIsLowerBound,
    unpricedRequests,
    unmeteredRequests,
  };
}
