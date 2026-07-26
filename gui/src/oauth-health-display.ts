/**
 * Dashboard helpers for OAuth account health badges.
 * Labels/summaries come from the management API; this maps status → badge tone.
 */

export type OAuthHealthStatus = "healthy" | "cooldown" | "reauth_required" | "warning";

export type OAuthHealthBadgeTone = "ok" | "warn" | "muted";

export function oauthHealthBadgeTone(status: OAuthHealthStatus | undefined): OAuthHealthBadgeTone {
  if (status === "healthy") return "ok";
  if (status === "cooldown") return "muted";
  if (status === "reauth_required" || status === "warning") return "warn";
  return "muted";
}

export function oauthHealthBadgeClass(status: OAuthHealthStatus | undefined): string {
  const tone = oauthHealthBadgeTone(status);
  if (tone === "ok") return "badge badge-green";
  if (tone === "warn") return "badge badge-amber";
  return "badge badge-muted";
}

/** Whether the UI should offer reauthenticate (not during cooldown-only). */
export function oauthHealthShowsReauth(status: OAuthHealthStatus | undefined): boolean {
  return status === "reauth_required";
}

/** Cooldown: show wait copy; do not urge probing or immediate retry. */
export function oauthHealthIsCooldown(status: OAuthHealthStatus | undefined): boolean {
  return status === "cooldown";
}

/** Non-healthy states where copying `ocx doctor` is a useful next step. */
export function oauthHealthShowsDoctor(status: OAuthHealthStatus | undefined): boolean {
  return status === "warning" || status === "reauth_required";
}
