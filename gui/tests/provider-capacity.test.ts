import { expect, test } from "bun:test";
import { capacityAggregationFromReport } from "../src/provider-workspace/report";

test("legacy provider quota reports remain valid without aggregation metadata", () => {
  expect(capacityAggregationFromReport({ quota: { weeklyPercent: 42 } })).toBeNull();
});

test("capacity metadata preserves estimate, raw current quota, recovery percent, and incomplete coverage", () => {
  const aggregation = capacityAggregationFromReport({
    quota: { weeklyPercent: 30.769230769, updatedAt: 123 },
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 1,
      weekly: {
        usedPercent: 30.769230769,
        nextRecoveryAt: 1_800_000_010_000,
        nextRecoveryPercent: 19.23076923,
      },
      currentAccount: {
        plan: "pro",
        quota: { weeklyPercent: 10, weeklyResetAt: 1_800_000_030, updatedAt: 123 },
      },
    },
  });
  expect(aggregation).toMatchObject({
    incomplete: true,
    excludedAccounts: 2,
    unknownPlanAccounts: 1,
    weekly: { usedPercent: 30.769230769, nextRecoveryPercent: 19.23076923 },
    currentAccount: { plan: "pro", quota: { weeklyPercent: 10 } },
  });
  expect(aggregation?.weekly).not.toHaveProperty("projectedUsedPercentAfterReset");
});

test("malformed or future aggregation contracts fail closed", () => {
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v2" } })).toBeNull();
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v1", scope: "routable-known" } })).toBeNull();
});
