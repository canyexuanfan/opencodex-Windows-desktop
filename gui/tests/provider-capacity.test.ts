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
      presentation: "aggregate",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 1,
      partialWindowAccounts: 0,
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
    presentation: "aggregate",
    incomplete: true,
    excludedAccounts: 2,
    unknownPlanAccounts: 1,
    partialWindowAccounts: 0,
    weekly: { usedPercent: 30.769230769, nextRecoveryPercent: 19.23076923 },
    currentAccount: { plan: "pro", quota: { weeklyPercent: 10 } },
  });
  expect(aggregation?.weekly).not.toHaveProperty("projectedUsedPercentAfterReset");
});

test("fallback and coverage-only metadata never become aggregate presentation", () => {
  const fallback = capacityAggregationFromReport({
    quota: { weeklyPercent: 80, updatedAt: 123 },
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      presentation: "effective-account-fallback",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 0,
    },
  });
  expect(fallback?.presentation).toBe("effective-account-fallback");
  const legacyCoverage = capacityAggregationFromReport({
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 1,
    },
  });
  expect(legacyCoverage?.presentation).toBe("coverage-only");
});

test("capacity recovery layout wraps and stacks in narrow provider panes", async () => {
  const css = await Bun.file(new URL("../src/styles/provider-overview-dashboard.css", import.meta.url)).text();
  expect(css).toContain(".pws-capacity-recovery {");
  expect(css).toContain("flex-wrap: wrap;");
  expect(css).toContain("overflow-wrap: anywhere;");
  expect(css).toContain("@container (max-width: 520px)");
  expect(css.slice(css.indexOf("@container (max-width: 520px)"))).toContain("grid-template-columns: minmax(0, 1fr);");
});

test("malformed or future aggregation contracts fail closed", () => {
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v2" } })).toBeNull();
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v1", scope: "routable-known" } })).toBeNull();
});
