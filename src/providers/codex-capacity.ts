export const CODEX_CONFIGURED_CAPACITY_WEIGHTS = {
  plus: 1,
  business: 1,
  prolite: 5,
  pro: 20,
} as const;

export type CodexCapacityQuota = {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: Array<{ label: string; percent: number; resetAt?: number }>;
  updatedAt: number;
};

export interface CodexCapacityAccount {
  isMain: boolean;
  active?: boolean;
  plan?: string | null;
  paused: boolean;
  needsReauth?: boolean;
  quota: CodexCapacityQuota | null;
}

export interface CodexCapacityWindowAggregation {
  usedPercent: number;
  includedAccounts: number;
  totalWeight: number;
  consumedWeight: number;
  remainingWeight: number;
  nextRecoveryAt?: number;
  nextRecoveryPercent?: number;
}

export interface CodexCapacityAggregation {
  kind: "capacity-weighted-v1";
  scope: "routable-known";
  includedAccounts: number;
  excludedAccounts: number;
  unknownPlanAccounts: number;
  missingQuotaAccounts: number;
  pausedAccounts: number;
  reauthAccounts: number;
  incomplete: boolean;
  fiveHour?: CodexCapacityWindowAggregation;
  weekly?: CodexCapacityWindowAggregation;
  monthly?: CodexCapacityWindowAggregation;
  customWindows?: Array<CodexCapacityWindowAggregation & { label: string }>;
  currentAccount?: {
    isMain: boolean;
    plan?: string | null;
    quota: CodexCapacityQuota | null;
  };
}

export interface CodexCapacityResult {
  quota: CodexCapacityQuota | null;
  aggregation: CodexCapacityAggregation | null;
  currentAccount?: CodexCapacityAggregation["currentAccount"];
}

type MutableWindow = {
  totalWeight: number;
  consumedWeight: number;
  includedAccounts: number;
  recoveries: Map<number, number>;
};

function configuredWeight(plan: string | null | undefined): number | undefined {
  const normalized = plan?.trim().toLowerCase();
  return normalized && normalized in CODEX_CONFIGURED_CAPACITY_WEIGHTS
    ? CODEX_CONFIGURED_CAPACITY_WEIGHTS[normalized as keyof typeof CODEX_CONFIGURED_CAPACITY_WEIGHTS]
    : undefined;
}

function normalizedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

function futureResetMs(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return milliseconds > now ? milliseconds : undefined;
}

function addWindow(
  windows: Map<string, MutableWindow>,
  key: string,
  weight: number,
  percent: number,
  resetAt: number | undefined,
): void {
  const window = windows.get(key) ?? {
    totalWeight: 0,
    consumedWeight: 0,
    includedAccounts: 0,
    recoveries: new Map<number, number>(),
  };
  const consumed = weight * percent / 100;
  window.totalWeight += weight;
  window.consumedWeight += consumed;
  window.includedAccounts += 1;
  if (resetAt !== undefined) {
    window.recoveries.set(resetAt, (window.recoveries.get(resetAt) ?? 0) + consumed);
  }
  windows.set(key, window);
}

function finalizeWindow(window: MutableWindow): CodexCapacityWindowAggregation {
  const nextRecoveryAt = [...window.recoveries.keys()].sort((a, b) => a - b)[0];
  const recovered = nextRecoveryAt === undefined ? undefined : window.recoveries.get(nextRecoveryAt);
  return {
    usedPercent: window.consumedWeight / window.totalWeight * 100,
    includedAccounts: window.includedAccounts,
    totalWeight: window.totalWeight,
    consumedWeight: window.consumedWeight,
    remainingWeight: window.totalWeight - window.consumedWeight,
    ...(nextRecoveryAt !== undefined ? { nextRecoveryAt } : {}),
    ...(recovered !== undefined ? { nextRecoveryPercent: recovered / window.totalWeight * 100 } : {}),
  };
}

/** Display-only configured-weight estimate. It never participates in account selection or routing. */
export function aggregateCodexPoolCapacity(
  accounts: readonly CodexCapacityAccount[],
  now = Date.now(),
): CodexCapacityResult {
  const current = accounts.find(account => account.active)
    ?? accounts.find(account => account.isMain)
    ?? accounts[0];
  const currentAccount = current ? {
    isMain: current.isMain,
    ...(current.plan !== undefined ? { plan: current.plan } : {}),
    quota: current.quota,
  } : undefined;
  const windows = new Map<string, MutableWindow>();
  const included = new Set<CodexCapacityAccount>();
  let unknownPlanAccounts = 0;
  let missingQuotaAccounts = 0;
  let pausedAccounts = 0;
  let reauthAccounts = 0;
  let updatedAt = 0;

  for (const account of accounts) {
    const weight = configuredWeight(account.plan);
    if (weight === undefined) unknownPlanAccounts += 1;
    if (account.paused) pausedAccounts += 1;
    if (account.needsReauth) reauthAccounts += 1;
    const quota = account.quota;
    const standard = quota ? [
      ["fiveHour", quota.fiveHourPercent, quota.fiveHourResetAt],
      ["weekly", quota.weeklyPercent, quota.weeklyResetAt],
      ["monthly", quota.monthlyPercent, quota.monthlyResetAt],
    ] as const : [];
    const custom = quota?.customWindows ?? [];
    const hasQuota = standard.some(([, percent]) => normalizedPercent(percent) !== undefined)
      || custom.some(window => normalizedPercent(window.percent) !== undefined);
    if (!hasQuota) missingQuotaAccounts += 1;
    if (account.paused || account.needsReauth || weight === undefined || !quota || !hasQuota) continue;

    let contributed = false;
    for (const [key, rawPercent, rawReset] of standard) {
      const percent = normalizedPercent(rawPercent);
      if (percent === undefined) continue;
      addWindow(windows, key, weight, percent, futureResetMs(rawReset, now));
      contributed = true;
    }
    for (const customWindow of custom) {
      const percent = normalizedPercent(customWindow.percent);
      if (percent === undefined) continue;
      addWindow(windows, `custom:${customWindow.label}`, weight, percent, futureResetMs(customWindow.resetAt, now));
      contributed = true;
    }
    if (contributed) {
      included.add(account);
      updatedAt = Math.max(updatedAt, quota.updatedAt);
    }
  }

  if (windows.size === 0) return { quota: null, aggregation: null, ...(currentAccount ? { currentAccount } : {}) };
  const fiveHour = windows.get("fiveHour") ? finalizeWindow(windows.get("fiveHour")!) : undefined;
  const weekly = windows.get("weekly") ? finalizeWindow(windows.get("weekly")!) : undefined;
  const monthly = windows.get("monthly") ? finalizeWindow(windows.get("monthly")!) : undefined;
  const customWindows = [...windows.entries()].flatMap(([key, window]) => key.startsWith("custom:")
    ? [{ label: key.slice("custom:".length), ...finalizeWindow(window) }]
    : []);
  const quota: CodexCapacityQuota = {
    ...(fiveHour ? { fiveHourPercent: fiveHour.usedPercent } : {}),
    ...(weekly ? { weeklyPercent: weekly.usedPercent } : {}),
    ...(monthly ? { monthlyPercent: monthly.usedPercent } : {}),
    ...(customWindows.length > 0 ? {
      customWindows: customWindows.map(window => ({ label: window.label, percent: window.usedPercent })),
    } : {}),
    updatedAt: updatedAt || now,
  };
  const excludedAccounts = accounts.length - included.size;
  const aggregation: CodexCapacityAggregation = {
    kind: "capacity-weighted-v1",
    scope: "routable-known",
    includedAccounts: included.size,
    excludedAccounts,
    unknownPlanAccounts,
    missingQuotaAccounts,
    pausedAccounts,
    reauthAccounts,
    incomplete: excludedAccounts > 0,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    ...(currentAccount ? { currentAccount } : {}),
  };
  return { quota, aggregation, ...(currentAccount ? { currentAccount } : {}) };
}
