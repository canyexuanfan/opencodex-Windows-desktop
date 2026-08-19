export function formatEstimatedUsdValue(
  value: number,
  localeTag?: string,
  priorityLowerBound = false,
): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return `${priorityLowerBound ? "≥" : ""}~$${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)}`;
}
