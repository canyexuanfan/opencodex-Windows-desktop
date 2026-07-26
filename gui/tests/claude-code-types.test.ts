import { expect, test } from "bun:test";
import { formatCompactWindow } from "../src/pages/claude-code-types";

test("formatCompactWindow uses k below 1M and exact millions at/above 1M", () => {
  expect(formatCompactWindow(350_000)).toBe("350k");
  expect(formatCompactWindow(1_000_000)).toBe("1M");
  expect(formatCompactWindow(2_000_000)).toBe("2M");
  expect(formatCompactWindow(1_500_000)).toBe("1.5M");
});
