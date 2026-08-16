import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { samePathIdentity } from "../user-identity";

const TRUSTED_DARWIN_SYSTEM_ALIASES = [
  { alias: "/var", canonical: "/private/var" },
  { alias: "/tmp", canonical: "/private/tmp" },
] as const;

export function normalizeTrustedDarwinSystemAlias(path: string): string {
  const requested = resolve(path);
  if (process.platform !== "darwin") return requested;

  for (const entry of TRUSTED_DARWIN_SYSTEM_ALIASES) {
    if (requested !== entry.alias && !requested.startsWith(`${entry.alias}${sep}`)) continue;

    let actualAliasTarget: string;
    try {
      actualAliasTarget = realpathSync.native(entry.alias);
    } catch {
      // If the platform alias is absent or unreadable, keep the strict spelling check.
      return requested;
    }
    if (!samePathIdentity(actualAliasTarget, entry.canonical, "darwin")) return requested;
    return `${entry.canonical}${requested.slice(entry.alias.length)}`;
  }

  return requested;
}

/**
 * Compare a canonical realpath with a requested Log Guard path without treating
 * macOS's OS-owned /var and /tmp aliases as user-controlled redirections.
 * Arbitrary ancestor symlinks remain refused.
 */
export function sameLogGuardPathIdentity(realPath: string, requestedPath: string): boolean {
  return samePathIdentity(realPath, normalizeTrustedDarwinSystemAlias(requestedPath));
}
