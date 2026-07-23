import type { TKey } from "./i18n/shared";

export interface StartupRiskDetail {
  routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
  shimCoverage: "full" | "cli-only" | "none";
}

export function startupRiskDetailKey(health: StartupRiskDetail): TKey {
  if (health.routingKind === "custom-local") return "startup.riskDetailCustomLocal";
  if (health.shimCoverage === "cli-only") return "startup.riskDetailWindowsShim";
  return "startup.riskDetail";
}
