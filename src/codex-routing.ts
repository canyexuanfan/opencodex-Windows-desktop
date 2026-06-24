import { saveConfig } from "./config";
import { isCodexAccountUsable } from "./codex-account-usability";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-account-runtime-state";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./codex-quota";
import type { OcxConfig } from "./types";

const threadAccountMap = new Map<string, string>();
const upstreamHealth = new Map<string, { consecutiveFailures: number; lastFailureStatus?: number; lastFailureAt?: number }>();

function hasConfiguredPoolAccount(config: OcxConfig, accountId: string): boolean {
  return (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
}

export function clearThreadAccountMap(): void {
  threadAccountMap.clear();
}

export function clearThreadAccountMapForAccount(accountId: string): void {
  for (const [threadId, mappedAccountId] of threadAccountMap) {
    if (mappedAccountId === accountId) threadAccountMap.delete(threadId);
  }
}

export function clearCodexUpstreamHealth(): void {
  upstreamHealth.clear();
}

export function clearCodexUpstreamHealthForAccount(accountId: string): void {
  upstreamHealth.delete(accountId);
}

export function getCodexUpstreamHealth(
  accountId: string,
): { consecutiveFailures: number; lastFailureStatus?: number; lastFailureAt?: number } | null {
  return upstreamHealth.get(accountId) ?? null;
}

export function computeCodexUsageScore(quota: {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
} | null): number {
  if (!quota) return CODEX_UNKNOWN_USAGE_SCORE;
  const values = [quota.weeklyPercent, quota.fiveHourPercent, quota.monthlyPercent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : CODEX_UNKNOWN_USAGE_SCORE;
}

function getEligiblePoolAccounts(config: OcxConfig, excludeId?: string): string[] {
  return (config.codexAccounts ?? [])
    .filter(account => !account.isMain && account.id !== excludeId && !isAccountNeedsReauth(account.id))
    .filter(account => isCodexAccountUsable(config, account.id))
    .map(account => account.id);
}

function pickLowerUsageAccount(config: OcxConfig, active: string, activeUsage: number): string {
  let best = active;
  let bestUsage = activeUsage;
  for (const id of getEligiblePoolAccounts(config, active)) {
    const usage = computeCodexUsageScore(getAccountQuota(id));
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

export function pickLowestUsageCodexAccount(config: OcxConfig, excludeId?: string): string | null {
  let best: string | null = null;
  let bestUsage = Number.POSITIVE_INFINITY;
  for (const id of getEligiblePoolAccounts(config, excludeId)) {
    const usage = computeCodexUsageScore(getAccountQuota(id));
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

function setActiveCodexAccount(config: OcxConfig, accountId: string): void {
  if (config.activeCodexAccountId === accountId) return;
  config.activeCodexAccountId = accountId;
  saveConfig(config);
}

function applyQuotaAutoSwitch(config: OcxConfig, active: string): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(quota);
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage);
  if (best !== active) setActiveCodexAccount(config, best);
  return best;
}

function shouldFailover(config: OcxConfig, accountId: string): boolean {
  const threshold = config.upstreamFailoverThreshold ?? 3;
  if (threshold <= 0) return false;
  const health = upstreamHealth.get(accountId);
  return !!health && health.consecutiveFailures >= threshold;
}

function applyFailureFailover(config: OcxConfig, active: string): string {
  if (!shouldFailover(config, active)) return active;
  const best = pickLowestUsageCodexAccount(config, active);
  if (best) {
    setActiveCodexAccount(config, best);
    return best;
  }
  return active;
}

export function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
): string | null {
  if (threadId && threadAccountMap.has(threadId)) {
    const mapped = threadAccountMap.get(threadId)!;
    if (isCodexAccountUsable(config, mapped)) return mapped;
    threadAccountMap.delete(threadId);
  }
  let active = config.activeCodexAccountId;
  if (!active) return null;
  if (!isCodexAccountUsable(config, active)) {
    const fallback = pickLowestUsageCodexAccount(config, active);
    if (fallback) {
      setActiveCodexAccount(config, fallback);
      active = fallback;
    } else if (hasConfiguredPoolAccount(config, active)) {
      return active;
    } else {
      return null;
    }
  }
  active = applyQuotaAutoSwitch(config, active);
  active = applyFailureFailover(config, active);
  if (!isCodexAccountUsable(config, active)) return null;
  if (threadId) threadAccountMap.set(threadId, active);
  return active;
}

export function recordCodexUpstreamOutcome(config: OcxConfig, accountId: string | null, status: number): void {
  if (!accountId) return;
  if (status >= 200 && status < 300) {
    upstreamHealth.delete(accountId);
    return;
  }
  const current = upstreamHealth.get(accountId);
  upstreamHealth.set(accountId, {
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
    lastFailureStatus: status,
    lastFailureAt: Date.now(),
  });
  if (status === 401) markAccountNeedsReauth(accountId);
  if (config.activeCodexAccountId === accountId) applyFailureFailover(config, accountId);
}

export function formatCodexProviderForLog(providerName: string, accountId: string | null, config: OcxConfig): string {
  if (!accountId) return providerName;
  const poolIndex = (config.codexAccounts ?? []).filter(a => !a.isMain).findIndex(a => a.id === accountId);
  return poolIndex >= 0 ? `${providerName}-${poolIndex + 1}` : providerName;
}
