import { describe, expect, test } from "bun:test";
import { runScenario } from "../src/lab/conformance/executor";
import { NEGATIVE_CONTROL_FIXTURES } from "../src/lab/conformance/negative-controls";
import { runNegativeControls } from "../src/lab/conformance/runner";

describe("CL-01 negative-control failure accounting", () => {
  test("does not count harness failures as rejected negative controls", async () => {
    let injected = false;
    const summary = await runNegativeControls(async (scenario) => {
      const result = await runScenario(scenario);
      if (injected) return result;
      injected = true;
      return {
        ...result,
        passed: false,
        classification: "harness_failure",
        secondaryCode: "execution_error",
        assertionResults: [],
        diagnostics: ["synthetic harness failure"],
      };
    });

    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(summary.rejected).toBe(summary.total - 1);
    expect(summary.passed).toBe(summary.rejected);
    expect(summary.failed).toBe(1);
    expect(summary.results.some((result) => result.classification === "harness_failure")).toBe(true);
  }, 120000);

  test("counts deterministic protocol failures as rejected negative controls", async () => {
    const summary = await runNegativeControls();

    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(summary.rejected).toBe(summary.total);
    expect(summary.failed).toBe(0);
    for (const result of summary.results) {
      expect(result.passed).toBe(false);
      expect(result.classification).toBe("protocol_failure");
      expect(result.secondaryCode).toBe("deterministic_assertion");
    }
  }, 120000);
});
