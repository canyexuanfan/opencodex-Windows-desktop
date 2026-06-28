import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  USAGE_DEBUG_ENV,
  USAGE_DEBUG_KEEP_LINES,
  USAGE_DEBUG_MAX_LINES,
  usageDebugPath,
} from "../src/usage-debug";

let testDir = "";
let previousHome: string | undefined;
let previousDebug: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDebug = process.env[USAGE_DEBUG_ENV];
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-debug-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDebug === undefined) delete process.env[USAGE_DEBUG_ENV];
  else process.env[USAGE_DEBUG_ENV] = previousDebug;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("isUsageDebugEnabled", () => {
  test("returns false by default", () => {
    delete process.env[USAGE_DEBUG_ENV];
    expect(isUsageDebugEnabled()).toBe(false);
  });

  test("returns true only when env equals exactly '1'", () => {
    process.env[USAGE_DEBUG_ENV] = "1";
    expect(isUsageDebugEnabled()).toBe(true);
    for (const value of ["0", "true", "yes", "TRUE", ""]) {
      process.env[USAGE_DEBUG_ENV] = value;
      expect(isUsageDebugEnabled()).toBe(false);
    }
  });
});

describe("truncateForDebug", () => {
  test("returns shorter strings verbatim", () => {
    expect(truncateForDebug("hello")).toBe("hello");
  });

  test("clamps and appends remaining-byte hint", () => {
    const big = "x".repeat(USAGE_DEBUG_BODY_SAMPLE_BYTES + 100);
    const clamped = truncateForDebug(big);
    expect(clamped.startsWith("x".repeat(USAGE_DEBUG_BODY_SAMPLE_BYTES))).toBe(true);
    expect(clamped).toContain("... [+100 more]");
  });

  test("respects a custom max", () => {
    expect(truncateForDebug("abcdef", 3)).toBe("abc... [+3 more]");
  });
});

describe("appendUsageDebug", () => {
  function sample(extra: Partial<{ requestId: string; ts: number }> = {}) {
    return {
      ts: extra.ts ?? 1,
      requestId: extra.requestId ?? "ocx-debug-1",
      provider: "chatgpt",
      model: "gpt-5.5",
      upstreamContentType: "text/event-stream",
      upstreamStatus: 200,
      bodyKind: "sse" as const,
      bodySample: "data: {\"type\":\"response.completed\"}",
      extractedUsage: null,
    };
  }

  test("appends one JSON line with the expected shape and 0o600 perms", () => {
    appendUsageDebug(sample());
    const path = usageDebugPath();
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.requestId).toBe("ocx-debug-1");
    expect(parsed.bodyKind).toBe("sse");
    expect(parsed.upstreamContentType).toBe("text/event-stream");
    if (process.platform !== "win32") {
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("rotates to the most recent USAGE_DEBUG_KEEP_LINES once USAGE_DEBUG_MAX_LINES is exceeded", () => {
    // Lazy rotation: append #(MAX+1) triggers one rewrite to KEEP. Subsequent appends
    // grow the file again up to MAX before the next rewrite. After MAX+1 appends the
    // file holds exactly KEEP lines and the most-recent record survives.
    const total = USAGE_DEBUG_MAX_LINES + 1;
    for (let i = 0; i < total; i++) {
      appendUsageDebug(sample({ requestId: `ocx-${i}`, ts: i }));
    }
    const path = usageDebugPath();
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(USAGE_DEBUG_KEEP_LINES);
    const last = JSON.parse(lines[lines.length - 1]) as { requestId: string };
    const first = JSON.parse(lines[0]) as { requestId: string };
    expect(last.requestId).toBe(`ocx-${total - 1}`);
    expect(first.requestId).toBe(`ocx-${total - USAGE_DEBUG_KEEP_LINES}`);
  });

  test("keeps file size bounded by MAX_LINES across long runs", () => {
    for (let i = 0; i < USAGE_DEBUG_MAX_LINES * 3; i++) {
      appendUsageDebug(sample({ requestId: `ocx-${i}`, ts: i }));
    }
    const path = usageDebugPath();
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(USAGE_DEBUG_MAX_LINES);
    expect(lines.length).toBeGreaterThanOrEqual(USAGE_DEBUG_KEEP_LINES);
  });
});
