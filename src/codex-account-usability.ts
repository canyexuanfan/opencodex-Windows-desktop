import { getCodexAccountCredential } from "./codex-account-store";
import { isAccountNeedsReauth } from "./codex-account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID, isMainAccountTokenLive } from "./codex-main-account";
import type { OcxConfig } from "./types";

export function isCodexAccountUsable(config: OcxConfig, accountId: string): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Main account: credential is the read-only ~/.codex/auth.json token (Option A).
    return isMainAccountTokenLive() && !isAccountNeedsReauth(accountId);
  }
  const exists = (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
  if (!exists) return false;
  if (isAccountNeedsReauth(accountId)) return false;
  return !!getCodexAccountCredential(accountId);
}
