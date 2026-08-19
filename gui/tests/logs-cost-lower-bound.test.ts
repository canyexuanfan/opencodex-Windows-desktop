import { describe, expect, test } from "bun:test";
import { DICTS, interpolate, type Locale, type TFn } from "../src/i18n/shared";
import {
  formatEstimatedUsdTotal,
  summarizeEstimatedCosts,
} from "../src/pages/logs-cost-format";

function translator(locale: Locale): TFn {
  return (key, vars) => interpolate(DICTS[locale][key], vars);
}

test("ordinary dashboard costs retain the estimate marker", () => {
  expect(formatEstimatedUsdTotal(0.77, false, "en-US", translator("en"))).toBe("~$0.7700");
});

test("priority long-context lower bounds render with a greater-than-or-equal marker", () => {
  expect(formatEstimatedUsdTotal(0.77, true, "en-US", translator("en"))).toBe("≥$0.7700");
});

test("USD placement and separators follow a non-English locale", () => {
  expect(formatEstimatedUsdTotal(0.77, false, "de-DE", translator("de"))).toBe("ca. 0,7700\u00a0$");
  expect(formatEstimatedUsdTotal(undefined, false, "de-DE", translator("de"))).toBe("nicht verfügbar");
});

describe("conversation cost lower-bound aggregation", () => {
  const priced = (total: number, lowerBound: boolean) => ({
    usageStatus: "reported",
    displayMetrics: {
      cost: {
        kind: "value" as const,
        estimate: { cost: { total } },
        estimateReasons: lowerBound ? ["priority_lower_bound"] : [],
      },
    },
  });

  test("marks a total only when every included priced estimate is a lower bound", () => {
    expect(summarizeEstimatedCosts([priced(0.77, true), priced(1.23, true)])).toMatchObject({
      estimatedCostUsd: 2,
      priorityLowerBound: true,
    });
    expect(summarizeEstimatedCosts([priced(0.77, true), priced(1.23, false)])).toMatchObject({
      estimatedCostUsd: 2,
      priorityLowerBound: false,
    });
  });

  test("preserves unpriced and unsupported exclusions without minting a lower bound", () => {
    expect(summarizeEstimatedCosts([
      { usageStatus: "reported", displayMetrics: { cost: { kind: "unavailable" } } },
      { usageStatus: "unsupported" },
    ])).toEqual({
      estimatedCostUsd: 0,
      priorityLowerBound: false,
      unpricedRequests: 1,
      unmeteredRequests: 1,
    });
  });
});
