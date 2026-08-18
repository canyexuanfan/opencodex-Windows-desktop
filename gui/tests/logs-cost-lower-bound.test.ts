import { expect, test } from "bun:test";
import { formatEstimatedUsdTotal } from "../src/pages/logs-cost-format";

test("ordinary dashboard costs retain the estimate marker", () => {
  expect(formatEstimatedUsdTotal(0.77, false, "en-US")).toBe("~$0.7700");
});

test("priority long-context lower bounds render with a greater-than-or-equal marker", () => {
  expect(formatEstimatedUsdTotal(0.77, true, "en-US")).toBe("≥$0.7700");
});
