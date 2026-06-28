import { describe, expect, test } from "bun:test";
import { formatCrashEntry } from "../src/crash-guard";

describe("crash-guard diagnostics", () => {
  test("adds a handler-stack when the error has only native frames", () => {
    const err = new TypeError("null is not an object");
    err.stack = "TypeError: null is not an object\n    at <anonymous> (native:1:11)\n    at processTicksAndRejections (native:7:39)";

    const entry = formatCrashEntry("unhandledRejection", err);

    expect(entry).toContain("TypeError: null is not an object");
    expect(entry).toContain("handler-stack:");
    expect(entry).toContain("crash-guard.ts");
  });

  test("does not add a handler-stack when a usable source frame exists", () => {
    const err = new TypeError("boom");
    err.stack = "TypeError: boom\n    at go (/Users/x/opencodex/src/server.ts:120:13)";

    const entry = formatCrashEntry("uncaughtException", err);

    expect(entry).not.toContain("handler-stack:");
  });

  test("captures constructor, keys, cause, and code for shaped errors", () => {
    const err = Object.assign(new Error("upstream failed"), { code: "ECONNRESET", cause: new Error("socket hang up") });

    const entry = formatCrashEntry("unhandledRejection", err);

    expect(entry).toContain("code: ECONNRESET");
    expect(entry).toContain("cause: Error: socket hang up");
  });

  test("never throws on non-object rejection values", () => {
    expect(() => formatCrashEntry("unhandledRejection", null)).not.toThrow();
    expect(() => formatCrashEntry("unhandledRejection", "string reason")).not.toThrow();
    expect(formatCrashEntry("unhandledRejection", 42)).toContain("42");
  });
});
