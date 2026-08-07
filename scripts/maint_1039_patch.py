from pathlib import Path


def edit(path: str, fn):
    p = Path(path)
    text = p.read_text()
    new = fn(text)
    if new == text:
        raise SystemExit(f"{path}: edit made no change")
    p.write_text(new)


def one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)


def many(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} occurrences, found {count}")
    return text.replace(old, new)


def patch_config(text: str) -> str:
    text = one(
        text,
        'import { isCodexAccountPriorityKey } from "./codex/account-priority";',
        'import { isCodexAccountPriorityKey } from "./codex/account-priority";\nimport { UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD } from "./codex/upstream-host-health";',
        "config import",
    )
    text = one(
        text,
        '  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024),',
        '''  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024),
  // Invalid hand edits disable only this opt-in circuit. Live writes remain strict.
  upstreamHostCircuitThreshold: z.number().int()
    .min(0)
    .max(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD)
    .optional()
    .catch(undefined),''',
        "config schema field",
    )

    warning_marker = 'type NativeSubagentPersistedField = "injectionModel" | "injectionEffort" | "syncCodexSubagentDefaults";'
    warning_helpers = '''function malformedUpstreamHostCircuitThresholdWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `upstreamHostCircuitThreshold ignored: expected an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

function warnDegradedUpstreamHostCircuitThreshold(rawParsed: unknown): void {
  const warning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

'''
    text = one(text, warning_marker, warning_helpers + warning_marker, "config warning helper")

    text = many(
        text,
        '      warnDegradedCodexAccountPicker(parsed);\n',
        '      warnDegradedCodexAccountPicker(parsed);\n      warnDegradedUpstreamHostCircuitThreshold(parsed);\n',
        2,
        "config load warnings",
    )
    text = one(
        text,
        '  if (pickerWarning) warnings.push(pickerWarning);\n',
        '  if (pickerWarning) warnings.push(pickerWarning);\n  const hostCircuitWarning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);\n  if (hostCircuitWarning) warnings.push(hostCircuitWarning);\n',
        "config diagnostics warning",
    )

    boundary_marker = '/**\n * Same reasoning as {@link blankHostnameError}, and more urgent:'
    boundary_helper = '''function upstreamHostCircuitThresholdError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `schema_invalid: upstreamHostCircuitThreshold: must be an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

'''
    text = one(text, boundary_marker, boundary_helper + boundary_marker, "config write-boundary helper")
    text = one(
        text,
        '    ?? appOwnedMemoryBudgetError(value)\n    ?? googleAntigravityStaticCatalogVersionError(value)',
        '    ?? appOwnedMemoryBudgetError(value)\n    ?? upstreamHostCircuitThresholdError(value)\n    ?? googleAntigravityStaticCatalogVersionError(value)',
        "config boundary chain",
    )
    return text


edit("src/config.ts", patch_config)


def patch_health(text: str) -> str:
    marker = '/** Record one terminal logical `connect_neutral` failure. */'
    helper = '''/**
 * Downgrade circuit-owned state when the operator disables the circuit.
 * Failure history remains observational, but cooldown and all in-flight lease
 * authority are revoked so disabled-mode traffic can update the ledger normally.
 */
export function disableUpstreamHostCircuitForKey(key: string, now = Date.now()): boolean {
  const entry = hostHealth.get(key);
  if (!entry?.circuitManaged) return false;
  entry.circuitManaged = false;
  delete entry.cooldownUntil;
  advanceGeneration(entry);
  entry.lastTouch = now;
  if (entry.consecutiveFailures === 0) hostHealth.delete(key);
  else pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
  return true;
}

'''
    return one(text, marker, helper + marker, "host disable helper")


edit("src/codex/upstream-host-health.ts", patch_health)


def add_disable_import(text: str) -> str:
    return one(
        text,
        '  acquireUpstreamHostAdmission,\n  normalizeUpstreamHostCircuitThreshold,',
        '  acquireUpstreamHostAdmission,\n  disableUpstreamHostCircuitForKey,\n  normalizeUpstreamHostCircuitThreshold,',
        "circuit disable import",
    )


edit("src/server/responses/core.ts", add_disable_import)
edit("src/server/responses/compact.ts", add_disable_import)


def patch_core(text: str) -> str:
    return one(
        text,
        '''    const hostCircuitEnabled = hostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (hostAdmissionLease && hostAdmissionLease.key !== hostKey) {''',
        '''    const hostCircuitEnabled = hostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (hostKey !== null && !hostCircuitEnabled) {
      disableUpstreamHostCircuitForKey(actualHostKey);
    }
    if (hostAdmissionLease && hostAdmissionLease.key !== hostKey) {''',
        "regular disabled-mode reconciliation",
    )


edit("src/server/responses/core.ts", patch_core)


def patch_compact(text: str) -> str:
    return one(
        text,
        '''    const compactHostCircuitEnabled = compactHostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (compactHostAdmissionLease && compactHostAdmissionLease.key !== compactHostKey) {''',
        '''    const compactHostCircuitEnabled = compactHostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (compactHostKey !== null && !compactHostCircuitEnabled) {
      disableUpstreamHostCircuitForKey(actualCompactHostKey);
    }
    if (compactHostAdmissionLease && compactHostAdmissionLease.key !== compactHostKey) {''',
        "compact disabled-mode reconciliation",
    )


edit("src/server/responses/compact.ts", patch_compact)


def patch_health_test(text: str) -> str:
    text = one(
        text,
        '  clearUpstreamHostHealth,\n',
        '  clearUpstreamHostHealth,\n  disableUpstreamHostCircuitForKey,\n',
        "health test import",
    )
    marker = '  test("a later physical retry without its lease cannot close a newer circuit", () => {'
    regression = '''  test("disabled traffic can clear an old circuit before it is re-enabled", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 11_000);
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBe(11_000 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS);

    expect(disableUpstreamHostCircuitForKey(key, 11_001)).toBe(true);
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBeUndefined();

    expect(resetUpstreamHostHealth(key)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();
    expect(acquireUpstreamHostAdmission(key, 1, 11_002).kind).toBe("admitted");
  });

'''
    return one(text, marker, regression + marker, "disabled-mode health regression")


edit("tests/upstream-host-circuit.test.ts", patch_health_test)

Path("tests/upstream-host-circuit-config.test.ts").write_text('''import { afterEach, describe, expect, test } from "bun:test";
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
''')
