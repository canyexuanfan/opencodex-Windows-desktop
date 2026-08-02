import { describe, expect, test } from "bun:test";
import { aggregateCodexPoolCapacity, type CodexCapacityAccount } from "../src/providers/codex-capacity";

const NOW = 1_800_000_000_000;
const account = (
  plan: string | null,
  weeklyPercent: number | undefined,
  options: Partial<CodexCapacityAccount> & { weeklyResetAt?: number; monthlyPercent?: number; monthlyResetAt?: number } = {},
): CodexCapacityAccount => ({
  isMain: false,
  plan,
  paused: false,
  quota: weeklyPercent === undefined && options.monthlyPercent === undefined ? null : {
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(options.weeklyResetAt !== undefined ? { weeklyResetAt: options.weeklyResetAt } : {}),
    ...(options.monthlyPercent !== undefined ? { monthlyPercent: options.monthlyPercent } : {}),
    ...(options.monthlyResetAt !== undefined ? { monthlyResetAt: options.monthlyResetAt } : {}),
    updatedAt: NOW,
  },
  ...options,
});

describe("configured-weight Codex pool capacity", () => {
  test("Pro + Prolite + Plus produces the issue #874 estimate and recovery share", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 10, { isMain: true, active: true, weeklyResetAt: NOW + 30_000 }),
      account("prolite", 100, { weeklyResetAt: NOW + 10_000 }),
      account("plus", 100, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBeCloseTo(30.769230769, 8);
    expect(result.aggregation?.weekly).toMatchObject({ totalWeight: 26, consumedWeight: 8, remainingWeight: 18 });
    expect(result.aggregation?.weekly?.nextRecoveryAt).toBe(NOW + 10_000);
    expect(result.aggregation?.weekly?.nextRecoveryPercent).toBeCloseTo(19.23076923, 8);
    expect(result.aggregation?.currentAccount?.quota?.weeklyPercent).toBe(10);
  });

  test("observed 8/100/100 and refreshed 9/100/100 remain exact weighted regressions", () => {
    const rows = (mainPercent: number) => [
      account("pro", mainPercent, { isMain: true, active: true }),
      account("prolite", 100),
      account("prolite", 100),
    ];
    expect(aggregateCodexPoolCapacity(rows(8), NOW).quota?.weeklyPercent).toBeCloseTo(38.66666667, 8);
    expect(aggregateCodexPoolCapacity(rows(9), NOW).quota?.weeklyPercent).toBeCloseTo(39.33333333, 8);
  });

  test("same-time resets group partial consumed capacity and expose only recovery percent", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 25, { weeklyResetAt: NOW + 10_000 }),
      account("prolite", 40, { weeklyResetAt: NOW + 10_000 }),
      account("plus", 100, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.aggregation?.weekly?.nextRecoveryPercent).toBeCloseTo(7 / 26 * 100, 8);
    expect(result.aggregation?.weekly).not.toHaveProperty("projectedUsedPercentAfterReset");
  });

  test("unknown, missing, paused, and reauth rows are excluded with incomplete coverage", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 10, { active: true, isMain: true }),
      account("team", 50),
      account("plus", undefined),
      account("prolite", 20, { paused: true }),
      account("business", 30, { needsReauth: true }),
    ], NOW);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 4,
      unknownPlanAccounts: 1,
      missingQuotaAccounts: 1,
      pausedAccounts: 1,
      reauthAccounts: 1,
      incomplete: true,
    });
    expect(result.quota?.weeklyPercent).toBe(10);
  });

  test("weekly and monthly windows aggregate independently", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 20),
      account("prolite", undefined, { monthlyPercent: 60 }),
      account("plus", 100, { monthlyPercent: 10 }),
    ], NOW);
    expect(result.aggregation?.weekly?.totalWeight).toBe(21);
    expect(result.aggregation?.monthly?.totalWeight).toBe(6);
    expect(result.quota?.weeklyPercent).toBeCloseTo(23.8095238, 7);
    expect(result.quota?.monthlyPercent).toBeCloseTo(51.6666667, 7);
  });

  test("expired resets are ignored and all-excluded pools retain effective-account fallback truth", () => {
    const expired = aggregateCodexPoolCapacity([
      account("pro", 10, { weeklyResetAt: NOW - 1, active: true, isMain: true }),
    ], NOW);
    expect(expired.aggregation?.weekly).not.toHaveProperty("nextRecoveryAt");
    const fallback = aggregateCodexPoolCapacity([
      account("team", 70, { active: true, isMain: true }),
      account("go", 80),
    ], NOW);
    expect(fallback.aggregation).toBeNull();
    expect(fallback.currentAccount?.quota?.weeklyPercent).toBe(70);
  });
});
