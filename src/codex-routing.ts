import { saveConfig } from "./config";
import { isCodexAccountUsable } from "./codex-account-usability";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-account-runtime-state";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./codex-quota";
import type { OcxConfig } from "./types";

const threadAccountMap = new Map<string, string>();
type CodexUpstreamHealth = {
  consecutiveFailures: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
};

const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
export const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;

const upstreamHealth = new Map<string, CodexUpstreamHealth>();

export type CodexUpstreamOutcome = number | "connect_error" | "timeout";
export type CodexUpstreamOutcomeClass = "success" | "credential" | "quota" | "transient" | "caller" | "unknown";
export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
};

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
): CodexUpstreamHealth | null {
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

export function classifyCodexUpstreamOutcome(outcome: CodexUpstreamOutcome): CodexUpstreamOutcomeClass {
  if (outcome === "connect_error" || outcome === "timeout") return "transient";
  if (!Number.isFinite(outcome)) return "unknown";
  if (outcome >= 200 && outcome < 300) return "success";
  if (outcome === 401 || outcome === 403) return "credential";
  if (outcome === 429) return "quota";
  if (outcome >= 400 && outcome < 500) return "caller";
  if (outcome >= 500 && outcome < 600) return "transient";
  return "unknown";
}

function clampCooldownMs(ms: number): number {
  return Math.min(Math.max(ms, 1), CODEX_MAX_QUOTA_COOLDOWN_MS);
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return clampCooldownMs(Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? clampCooldownMs(delay) : undefined;
}

function resetTimestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function parseResetCooldownMs(resetAt: unknown | unknown[] | undefined, now = Date.now()): number | undefined {
  const values = Array.isArray(resetAt) ? resetAt : [resetAt];
  let best: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    const clamped = clampCooldownMs(delay);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}

export function computeQuotaCooldownUntil(meta: CodexUpstreamOutcomeMeta = {}): number {
  const now = meta.now ?? Date.now();
  const retryAfterMs = parseRetryAfterMs(meta.retryAfter, now);
  const resetCooldownMs = retryAfterMs === undefined ? parseResetCooldownMs(meta.resetAt, now) : undefined;
  return now + (retryAfterMs ?? resetCooldownMs ?? CODEX_DEFAULT_QUOTA_COOLDOWN_MS);
}

export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
}

export function isCodexAccountInCooldown(accountId: string, now = Date.now()): boolean {
  return getCodexAccountCooldownUntil(accountId, now) !== null;
}

function isCodexAccountSelectable(config: OcxConfig, accountId: string, now: number): boolean {
  return !isCodexAccountInCooldown(accountId, now) && isCodexAccountUsable(config, accountId);
}

function getEligiblePoolAccounts(config: OcxConfig, excludeId?: string, now = Date.now()): string[] {
  return (config.codexAccounts ?? [])
    .filter(account => !account.isMain && account.id !== excludeId && !isAccountNeedsReauth(account.id))
    .filter(account => !isCodexAccountInCooldown(account.id, now))
    .filter(account => isCodexAccountUsable(config, account.id))
    .map(account => account.id);
}

function pickLowerUsageAccount(config: OcxConfig, active: string, activeUsage: number, now: number): string {
  let best = active;
  let bestUsage = activeUsage;
  for (const id of getEligiblePoolAccounts(config, active, now)) {
    const usage = computeCodexUsageScore(getAccountQuota(id));
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

export function pickLowestUsageCodexAccount(config: OcxConfig, excludeId?: string, now = Date.now()): string | null {
  let best: string | null = null;
  let bestUsage = Number.POSITIVE_INFINITY;
  for (const id of getEligiblePoolAccounts(config, excludeId, now)) {
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

function applyQuotaAutoSwitch(config: OcxConfig, active: string, now: number): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(quota);
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage, now);
  if (best !== active) setActiveCodexAccount(config, best);
  return best;
}

function shouldFailover(config: OcxConfig, accountId: string, now: number): boolean {
  const threshold = config.upstreamFailoverThreshold ?? 3;
  if (threshold <= 0) return false;
  const health = upstreamHealth.get(accountId);
  if (health?.lastFailureAt && now - health.lastFailureAt > CODEX_FAILURE_WINDOW_MS) return false;
  return !!health && health.consecutiveFailures >= threshold;
}

function applyFailureFailover(config: OcxConfig, active: string, now: number): string {
  if (!shouldFailover(config, active, now)) return active;
  const best = pickLowestUsageCodexAccount(config, active, now);
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
  const now = Date.now();
  if (threadId && threadAccountMap.has(threadId)) {
    const mapped = threadAccountMap.get(threadId)!;
    if (isCodexAccountSelectable(config, mapped, now)) return mapped;
    threadAccountMap.delete(threadId);
  }
  let active = config.activeCodexAccountId;
  if (!active) return null;
  if (!isCodexAccountSelectable(config, active, now)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now);
    if (fallback) {
      setActiveCodexAccount(config, fallback);
      active = fallback;
    } else if (hasConfiguredPoolAccount(config, active)) {
      return active;
    } else {
      return null;
    }
  }
  active = applyQuotaAutoSwitch(config, active, now);
  active = applyFailureFailover(config, active, now);
  if (!isCodexAccountUsable(config, active)) return hasConfiguredPoolAccount(config, active) ? active : null;
  if (isCodexAccountInCooldown(active, now)) return hasConfiguredPoolAccount(config, active) ? active : null;
  if (threadId) threadAccountMap.set(threadId, active);
  return active;
}

export function recordCodexUpstreamOutcome(
  config: OcxConfig,
  accountId: string | null,
  outcome: CodexUpstreamOutcome,
  meta: CodexUpstreamOutcomeMeta = {},
): void {
  if (!accountId) return;
  const now = meta.now ?? Date.now();
  const outcomeClass = classifyCodexUpstreamOutcome(outcome);
  if (outcomeClass === "success") {
    const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
    else upstreamHealth.delete(accountId);
    return;
  }
  if (outcomeClass === "caller") return;

  const lastFailureStatus = typeof outcome === "number" ? outcome : 0;
  if (outcomeClass === "credential") {
    upstreamHealth.set(accountId, {
      consecutiveFailures: 1,
      lastFailureStatus,
      lastFailureAt: now,
    });
    markAccountNeedsReauth(accountId);
    clearThreadAccountMapForAccount(accountId);
    return;
  }

  if (outcomeClass === "quota") {
    upstreamHealth.set(accountId, {
      consecutiveFailures: 0,
      lastFailureStatus,
      lastFailureAt: now,
      cooldownUntil: computeQuotaCooldownUntil(meta),
    });
    clearThreadAccountMapForAccount(accountId);
    if (config.activeCodexAccountId === accountId) {
      const fallback = pickLowestUsageCodexAccount(config, accountId, now);
      if (fallback) setActiveCodexAccount(config, fallback);
    }
    return;
  }

  const current = upstreamHealth.get(accountId);
  const stale = current?.lastFailureAt ? now - current.lastFailureAt > CODEX_FAILURE_WINDOW_MS : false;
  const cooldownUntil = getCodexAccountCooldownUntil(accountId, now) ?? undefined;
  upstreamHealth.set(accountId, {
    consecutiveFailures: stale ? 1 : (current?.consecutiveFailures ?? 0) + 1,
    lastFailureStatus,
    lastFailureAt: now,
    ...(cooldownUntil ? { cooldownUntil } : {}),
  });
  if (config.activeCodexAccountId === accountId) applyFailureFailover(config, accountId, now);
}

export function formatCodexProviderForLog(providerName: string, accountId: string | null, config: OcxConfig): string {
  if (!accountId) return providerName;
  const poolIndex = (config.codexAccounts ?? []).filter(a => !a.isMain).findIndex(a => a.id === accountId);
  return poolIndex >= 0 ? `${providerName}-${poolIndex + 1}` : providerName;
}
