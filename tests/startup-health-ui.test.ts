import { describe, expect, test } from "bun:test";
import { settingsPollMayCommit, startupRiskDetailKey } from "../gui/src/startup-health-ui";

describe("startup health UI decisions", () => {
  test("selects the shared risk-detail message", () => {
    expect(startupRiskDetailKey({ routingKind: "custom-local", shimCoverage: "none" }))
      .toBe("startup.riskDetailCustomLocal");
    expect(startupRiskDetailKey({ routingKind: "opencodex-local", shimCoverage: "cli-only" }))
      .toBe("startup.riskDetailWindowsShim");
    expect(startupRiskDetailKey({ routingKind: "unknown", shimCoverage: "none" }))
      .toBe("startup.riskDetail");
  });

  test("rejects stale or mutation-racing settings polls", () => {
    const started = { request: 4, mutation: 2 };
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: false })).toBe(true);
    expect(settingsPollMayCommit(started, { request: 5, mutation: 2, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 3, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: true })).toBe(false);
  });
});
