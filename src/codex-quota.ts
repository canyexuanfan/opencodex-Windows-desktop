export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  updatedAt: number;
};

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
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

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.weeklyPercent, quota.fiveHourPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  fiveHour: unknown,
  weeklyResetAt?: unknown,
  fiveHourResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
): void {
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextFiveHour = normalizeUsagePercent(fiveHour);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextFiveHour === undefined && nextMonthly === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.fiveHourPercent !== undefined ? { fiveHourPercent: existing.fiveHourPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.fiveHourResetAt !== undefined ? { fiveHourResetAt: existing.fiveHourResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextFiveHourResetAt = normalizeResetAt(fiveHourResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
  }
  if (nextFiveHour !== undefined) {
    quota.fiveHourPercent = nextFiveHour;
    if (nextFiveHourResetAt !== undefined) quota.fiveHourResetAt = nextFiveHourResetAt;
  }
  if (nextMonthly !== undefined) {
    quota.monthlyPercent = nextMonthly;
    if (nextMonthlyResetAt !== undefined) quota.monthlyResetAt = nextMonthlyResetAt;
  }

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
  if (!data.rate_limit) return null;
  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const weeklyPercent = normalizeUsagePercent(data.rate_limit.secondary_window?.used_percent);
  const fiveHourPercent = normalizeUsagePercent(data.rate_limit.primary_window?.used_percent);
  const monthlyPercent = normalizeUsagePercent(data.rate_limit.tertiary_window?.used_percent);
  const weeklyResetAt = normalizeResetAt(data.rate_limit.secondary_window?.reset_at);
  const fiveHourResetAt = normalizeResetAt(data.rate_limit.primary_window?.reset_at);
  const monthlyResetAt = normalizeResetAt(data.rate_limit.tertiary_window?.reset_at);
  if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (fiveHourPercent !== undefined) {
    quota.fiveHourPercent = fiveHourPercent;
    if (fiveHourResetAt !== undefined) quota.fiveHourResetAt = fiveHourResetAt;
  }
  if (monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }

  return hasKnownQuotaValue(quota) ? quota : null;
}
