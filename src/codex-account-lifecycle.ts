import { removeCodexAccountCredential } from "./codex-account-store";
import { clearAccountNeedsReauth } from "./codex-account-runtime-state";
import { clearAccountQuota } from "./codex-quota";
import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./codex-routing";
import type { OcxConfig } from "./types";

export function purgeCodexAccountRuntimeState(accountId: string): void {
  clearAccountNeedsReauth(accountId);
  clearAccountQuota(accountId);
  clearThreadAccountMapForAccount(accountId);
  clearCodexUpstreamHealthForAccount(accountId);
}

export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): void {
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? []).filter(account => account.id !== accountId);
  if (runtimeConfig.activeCodexAccountId === accountId) runtimeConfig.activeCodexAccountId = undefined;
  purgeCodexAccountRuntimeState(accountId);
}
