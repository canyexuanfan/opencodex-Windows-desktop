export function formatEstimatedUsdTotal(
  totalUsd: number | undefined,
  lowerBound: boolean,
  localeTag?: string,
): string {
  if (totalUsd === undefined || !Number.isFinite(totalUsd) || totalUsd < 0) return "\u2014";
  return `${lowerBound ? "≥$" : "~$"}${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(totalUsd)}`;
}
