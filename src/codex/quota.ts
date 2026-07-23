export type StoredAccountQuota = {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  updatedAt: number;
};

export type WhamWindow = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
    tertiary_window?: WhamWindow | null;
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};

const accountQuota = new Map<string, StoredAccountQuota>();

export const CODEX_UNKNOWN_USAGE_SCORE = 100;

export function normalizeUsagePercent(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

/** >=28d windows are monthly (weekly is 604800s; WHAM monthly is 2628000s). */
const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;

function isMonthlyWindowSeconds(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= MONTHLY_WINDOW_MIN_SECONDS;
}

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.weeklyPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  weeklyResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,
): void {
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextMonthly === undefined && resetCredits === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
  }
  if (nextMonthly !== undefined) {
    quota.monthlyPercent = nextMonthly;
    if (nextMonthlyResetAt !== undefined) quota.monthlyResetAt = nextMonthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  accountQuota.set(accountId, quota);
}

export function getAccountQuota(accountId: string): StoredAccountQuota | null {
  return accountQuota.get(accountId) ?? null;
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  return accountQuota.entries();
}

export function clearAccountQuota(accountId?: string): void {
  if (accountId) accountQuota.delete(accountId);
  else accountQuota.clear();
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    return resetCredits !== undefined ? { resetCredits } : null;
  }

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const thirtyDayOnly = data.plan_type?.trim().toLowerCase() === "go" || data.plan_type?.trim().toLowerCase() === "free";
  // primary_window was the 5h window; it now carries weekly data for GPT plans.
  // secondary_window is the legacy weekly source; prefer primary when present.
  // A primary window with limit_window_seconds >= 28d is a MONTHLY account window
  // (Team accounts ship 2628000s primaries — issue #315) and must not map to weekly.
  const primaryPercent = normalizeUsagePercent(data.rate_limit.primary_window?.used_percent);
  const secondaryPercent = normalizeUsagePercent(data.rate_limit.secondary_window?.used_percent);
  const tertiaryPercent = normalizeUsagePercent(data.rate_limit.tertiary_window?.used_percent);
  const primaryResetAt = normalizeResetAt(data.rate_limit.primary_window?.reset_at);
  const secondaryResetAt = normalizeResetAt(data.rate_limit.secondary_window?.reset_at);
  const tertiaryResetAt = normalizeResetAt(data.rate_limit.tertiary_window?.reset_at);
  const primaryIsMonthly = isMonthlyWindowSeconds(data.rate_limit.primary_window?.limit_window_seconds);
  const monthlyFromPrimary = primaryIsMonthly && primaryPercent !== undefined;
  // weekly source: primary unless primary is monthly; then secondary
  const weeklyPercent = primaryIsMonthly ? secondaryPercent : (primaryPercent ?? secondaryPercent);
  const weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : (primaryPercent !== undefined ? primaryResetAt : secondaryResetAt);
  // monthly source: a monthly primary with a usable percent wins over tertiary;
  // percent and reset always come from the SAME window (no cross-window pairing)
  const monthlyPercent = monthlyFromPrimary ? primaryPercent : tertiaryPercent;
  const monthlyResetAt = monthlyFromPrimary ? primaryResetAt : tertiaryResetAt;
  if (thirtyDayOnly) {
    // go/free thirty-day accounts keep their historical tertiary-only contract
    // (locked by tests; monthly-primary payloads have not been observed on these plans).
    if (tertiaryPercent !== undefined) {
      quota.monthlyPercent = tertiaryPercent;
      if (tertiaryResetAt !== undefined) quota.monthlyResetAt = tertiaryResetAt;
    }
  } else if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (!thirtyDayOnly && monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
