import { CODEX_ACCOUNT_LOG_LABEL_RE } from "./codex-account-label";

export function baseProviderLabel(provider: string): string {
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return provider;
  const suffix = provider.slice(cut + 1);
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix) ? provider.slice(0, cut) : provider;
}
