import type { OcxConfig } from "../../types";
import { isMainCodexAccountTarget } from "../account-namespaces";
import type { RawEntry } from "./parsing";

/** Stable marker used to distinguish generated account rows from provider-owned catalog rows. */
export const CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION =
  "OpenAI native model bound to a Codex account namespace.";
export const CODEX_ACCOUNT_BOUND_CATALOG_KIND = "account-selector-v1";

/**
 * Public selectors whose configured account row still exists.
 *
 * Stale mappings stay in config so exact routing keeps failing closed, but they must not advertise
 * a deleted account. Credential health, pause, and reauthentication state intentionally do not
 * churn catalog identity. Only selector keys leave this boundary; private account ids do not.
 */
export function visibleCodexAccountSelectors(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces">,
): string[] {
  const storedPoolAccounts = new Set(
    (config.codexAccounts ?? [])
      .filter(account => !account.isMain)
      .map(account => account.id),
  );
  return Object.entries(config.codexAccountNamespaces ?? {})
    .filter(([, accountId]) =>
      isMainCodexAccountTarget(accountId) || storedPoolAccounts.has(accountId)
    )
    .map(([selector]) => selector);
}

export function accountBoundNativeDisplayName(selector: string, native: RawEntry): string {
  const rawModel = typeof native.display_name === "string"
    ? native.display_name
    : String(native.slug ?? "");
  const model = rawModel
    .replace(/^gpt-/i, "")
    .split("-")
    .filter(Boolean)
    .map(part => /^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
  return `${selector} / ${model}`;
}

function accountBoundNativeCatalogSlug(entry: RawEntry): string | undefined {
  if (entry.description !== CODEX_ACCOUNT_BOUND_CATALOG_DESCRIPTION
    || typeof entry.slug !== "string") return undefined;
  const slash = entry.slug.indexOf("/");
  return slash > 0 ? entry.slug.slice(slash + 1) : undefined;
}

/** Identify current generated rows without changing Codex's semantic model fields. */
export function trustedAccountBoundNativeCatalogSlug(entry: RawEntry): string | undefined {
  return entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND
    ? accountBoundNativeCatalogSlug(entry)
    : undefined;
}

export function accountBoundNativeModelSlugs(
  config: Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces">,
  nativeSlugs: Iterable<string>,
): string[] {
  const natives = [...nativeSlugs];
  return visibleCodexAccountSelectors(config)
    .flatMap(selector => natives.map(slug => `${selector}/${slug}`));
}
