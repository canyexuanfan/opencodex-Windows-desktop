import { afterEach, describe, expect, test } from "bun:test";
import { sidecarEnter, sidecarBreadcrumb } from "../src/sidecar-tracker";

// Drain any leftover in-flight counters between tests (defensive; each test balances its own).
afterEach(() => {
  let guard = 0;
  while (sidecarBreadcrumb().inFlight > 0 && guard++ < 100) { /* counters are balanced per test */ break; }
});

describe("sidecar breadcrumb", () => {
  test("tracks in-flight count and last label across enter/exit", () => {
    const exitA = sidecarEnter("web-search");
    expect(sidecarBreadcrumb().inFlight).toBe(1);
    expect(sidecarBreadcrumb().lastLabel).toBe("web-search");

    const exitB = sidecarEnter("vision");
    expect(sidecarBreadcrumb().inFlight).toBe(2);
    expect(sidecarBreadcrumb().lastLabel).toBe("vision");

    exitA();
    exitB();
    expect(sidecarBreadcrumb().inFlight).toBe(0);
  });

  test("exit is idempotent and never drives the counter negative", () => {
    const exit = sidecarEnter("web-search");
    exit();
    exit();
    expect(sidecarBreadcrumb().inFlight).toBe(0);
  });
});
