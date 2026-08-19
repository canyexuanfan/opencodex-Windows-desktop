export function formatEstimatedUsdValue(
  value: number,
  localeTag?: string,
  priorityLowerBound = false,
): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return `${priorityLowerBound ? "≥$" : "~$"}${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)}`;
}

export function formatEstimatedUsd(
  result: {
    kind: "value";
    estimate: { cost: { total: number }; priorityLowerBound?: boolean };
  } | { kind: "unavailable" } | undefined,
  localeTag?: string,
): string {
  if (!result || result.kind === "unavailable") return "\u2014";
  return formatEstimatedUsdValue(
    result.estimate.cost.total,
    localeTag,
    result.estimate.priorityLowerBound,
  );
}
