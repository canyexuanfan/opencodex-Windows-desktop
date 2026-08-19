import { describe, expect, test } from "bun:test";
import { formatEstimatedUsd, formatEstimatedUsdValue } from "../src/pages/logs-cost-format";

describe("Logs priority lower-bound formatting", () => {
  test("prefixes confirmed unpriced priority estimates with the lower-bound marker", () => {
    expect(formatEstimatedUsdValue(1.6, "en-US", true)).toBe("≥$1.6000");
  });

  test("keeps ordinary standard-price estimates unchanged", () => {
    expect(formatEstimatedUsdValue(1.6, "en-US", false)).toBe("~$1.6000");
  });
});

describe("Logs table cost formatting", () => {
  test("uses the shared value formatter for lower bounds, ordinary estimates, and unavailable costs", () => {
    expect(formatEstimatedUsd({
      kind: "value",
      estimate: { cost: { total: 1.6 }, priorityLowerBound: true },
    }, "en-US")).toBe("≥$1.6000");
    expect(formatEstimatedUsd({
      kind: "value",
      estimate: { cost: { total: 1.6 } },
    }, "en-US")).toBe("~$1.6000");
    expect(formatEstimatedUsd({ kind: "unavailable" }, "en-US")).toBe("—");
  });
});
