import { getCodexAccountCredential } from "./codex-account-store";
import { isAccountNeedsReauth } from "./codex-account-runtime-state";
import type { OcxConfig } from "./types";

export function isCodexAccountUsable(config: OcxConfig, accountId: string): boolean {
  const exists = (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
  if (!exists) return false;
  if (isAccountNeedsReauth(accountId)) return false;
  return !!getCodexAccountCredential(accountId);
}
