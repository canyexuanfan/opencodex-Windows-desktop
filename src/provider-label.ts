import { CODEX_ACCOUNT_LOG_LABEL_RE } from "./codex-account-label";

export function baseProviderLabel(provider: string): string {
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return provider;
  const suffix = provider.slice(cut + 1);
  // `-main` is the legacy log label for the main Codex account (MAIN_CODEX_ACCOUNT_ID). New entries
  // log under the base provider name, but historical `<provider>-main` entries must still collapse so
  // the usage table aggregates the main account into a single row instead of a stray split.
  if (suffix === "main") return provider.slice(0, cut);
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix) ? provider.slice(0, cut) : provider;
}
