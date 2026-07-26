import { maskAccountId } from "../lib/privacy";
import type { OAuthAccountHealth, OAuthHealthEntry } from "../oauth/health";

function describeHealth(health: OAuthAccountHealth): string {
  switch (health.status) {
    case "healthy":
      return "healthy";
    case "reauth_required":
      return "reauthentication required";
    case "cooldown":
      return health.reason === "rate_limit"
        ? `rate limited until ${health.until}`
        : `quota limited until ${health.until}`;
    case "warning":
      switch (health.reason) {
        case "refresh_conflict":
          return "refresh conflict";
        case "metadata_mismatch":
          return "metadata mismatch";
        case "stale_credentials":
          return "stale credentials";
      }
  }
}

/** Human-readable OAuth health block for `ocx status` (redacted account ids, no tokens). */
export function formatOAuthHealthForStatus(entries: OAuthHealthEntry[]): string {
  if (entries.length === 0) return "";

  const notable = entries.filter((entry) => entry.health.status !== "healthy");
  if (notable.length === 0) return "OAuth health: ok";

  const lines = ["OAuth health: warning"];
  for (const entry of notable) {
    const masked = maskAccountId(entry.accountId) ?? "account-…????";
    lines.push(`  ${entry.provider}  ${masked}  ${describeHealth(entry.health)}`);
    if (entry.action) {
      lines.push(`    Action: ${entry.action}`);
    }
  }
  return lines.join("\n");
}
