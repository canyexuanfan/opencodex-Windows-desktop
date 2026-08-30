/**
 * CLI-versus-proxy version skew (#2701).
 *
 * The reported failure: `ocx` on PATH is an older install than the running proxy, so its
 * help describes commands the proxy does not have and its output describes a different
 * build. Nothing surfaced that, because the CLI never compared the two.
 *
 * Kept in its own module rather than inside `status.ts` so `doctor` can reuse the exact
 * comparison instead of reimplementing it -- two diagnostics disagreeing about whether an
 * install is stale would be worse than neither reporting it.
 */

/** Placeholder versions that mean "unknown", not "different". */
const PLACEHOLDERS = new Set(["unknown", "0.0.0"]);

export interface VersionSkew {
  readonly cliVersion: string;
  /** Version the live proxy reported, or null when nothing is live or it reported none. */
  readonly proxyVersion: string | null;
  readonly skewed: boolean;
  /** Operator-facing explanation; null when there is nothing to report. */
  readonly warning: string | null;
}

/**
 * Compare the running CLI against the live proxy.
 *
 * Suppressed rather than reported when either side is a placeholder. `packageVersion()`
 * answers `"unknown"` when `package.json` carries no string version, and the server's
 * `VERSION` falls back to `"0.0.0"` when it cannot resolve its own package -- comparing
 * against either would report skew that says nothing about the install. A false stale-CLI
 * warning would send an operator to reinstall a healthy setup.
 */
export function computeVersionSkew(cliVersion: string, proxyVersion: string | undefined): VersionSkew {
  const proxy = proxyVersion ?? null;
  if (proxy === null || PLACEHOLDERS.has(proxy) || PLACEHOLDERS.has(cliVersion) || proxy === cliVersion) {
    return { cliVersion, proxyVersion: proxy, skewed: false, warning: null };
  }
  return {
    cliVersion,
    proxyVersion: proxy,
    skewed: true,
    warning: `CLI ${cliVersion} does not match the running proxy ${proxy} — this ocx on PATH is stale. `
      + "Its help and features describe a different build. Reinstall, or run the proxy's own binary.",
  };
}
