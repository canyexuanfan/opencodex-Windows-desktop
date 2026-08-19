import { describe, expect, test } from "bun:test";
import { formatEstimatedUsdValue } from "../src/pages/logs-cost-format";

describe("Logs priority lower-bound formatting", () => {
  test("prefixes confirmed unpriced priority estimates with the lower-bound marker", () => {
    expect(formatEstimatedUsdValue(1.6, "en-US", true)).toBe("≥~$1.6000");
  });

  test("keeps ordinary standard-price estimates unchanged", () => {
    expect(formatEstimatedUsdValue(1.6, "en-US", false)).toBe("~$1.6000");
  });
});
