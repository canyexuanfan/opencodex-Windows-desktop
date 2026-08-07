import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, readConfigDiagnostics, validateConfigCandidate } from "../src/config";

let testDir = "";

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("upstreamHostCircuitThreshold config contract", () => {
  test("live writes accept only integer values from 0 through 20", () => {
    for (const value of [0, 1, 20]) {
      expect(validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value }).ok).toBe(true);
    }
    for (const value of [-1, 1.5, 21, "3", null]) {
      const result = validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("upstreamHostCircuitThreshold");
    }
  });

  test("malformed hand edits disable only the circuit and report a warning", () => {
    testDir = mkdtempSync(join(tmpdir(), "ocx-host-circuit-config-"));
    process.env.OPENCODEX_HOME = testDir;
    writeFileSync(getConfigPath(), JSON.stringify({
      ...getDefaultConfig(),
      upstreamHostCircuitThreshold: 999,
    }));

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.upstreamHostCircuitThreshold).toBeUndefined();
    expect(diagnostics.warnings).toContain(
      "upstreamHostCircuitThreshold ignored: expected an integer from 0 to 20",
    );
    expect(Object.keys(diagnostics.config.providers).length).toBeGreaterThan(0);
  });
});
