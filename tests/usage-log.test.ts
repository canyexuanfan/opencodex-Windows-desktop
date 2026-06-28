import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  readUsageEntries,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
} from "../src/usage-log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage log", () => {
  test("uses OPENCODEX_HOME for the append-only JSONL path", () => {
    expect(usageLogPath()).toBe(join(testDir, "usage.jsonl"));
  });

  test("appends secret-safe usage entries and reads them back", () => {
    appendUsageEntry({
      requestId: "ocx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
      totalTokens: 13,
    });

    expect(existsSync(usageLogPath())).toBe(true);
    const raw = readFileSync(usageLogPath(), "utf-8");
    expect(raw).toContain("\"requestId\":\"ocx-1\"");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("authorization");
    expect(readUsageEntries()).toEqual([{
      requestId: "ocx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
      totalTokens: 13,
    }]);
    if (process.platform !== "win32") {
      expect((statSync(usageLogPath()).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("skips malformed JSONL lines while keeping valid entries", () => {
    writeFileSync(usageLogPath(), [
      "{\"requestId\":\"a\",\"timestamp\":1,\"provider\":\"p\",\"model\":\"m\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"unreported\"}",
      "{not-json",
      "{\"requestId\":\"b\",\"timestamp\":2,\"provider\":\"p\",\"model\":\"m\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"reported\",\"usage\":{\"inputTokens\":1,\"outputTokens\":2},\"totalTokens\":3}",
    ].join("\n"));

    expect(readUsageEntries().map(entry => entry.requestId)).toEqual(["a", "b"]);
  });

  test("keeps missing usage distinct from zero usage", () => {
    expect(usageStatusForFinalLog(undefined)).toBe("unreported");
    expect(usageStatusForFinalLog({ inputTokens: 0, outputTokens: 0 })).toBe("reported");
    expect(usageTotalTokens(undefined)).toBeUndefined();
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 })).toBe(10);
  });
});
