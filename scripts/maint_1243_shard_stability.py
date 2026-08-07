from pathlib import Path

reach = Path("tests/upstream-reachability.test.ts")
text = reach.read_text()
text = text.replace(
    'import { describe, expect, test } from "bun:test";',
    'import { beforeEach, describe, expect, test } from "bun:test";',
    1,
)
old_import = '''import {
  clearUpstreamHostHealth,
  getUpstreamHostHealth,
  recordUpstreamHostFailure,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  UPSTREAM_HOST_FAILURE_WINDOW_MS,
  UPSTREAM_HOST_HEALTH_MAX_ENTRIES,
} from "../src/codex/upstream-host-health";'''
new_import = '''import {
  UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
  UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
  UPSTREAM_HOST_FAILURE_WINDOW_MS,
  UPSTREAM_HOST_HEALTH_MAX_ENTRIES,
  acquireUpstreamHostAdmission,
  clearUpstreamHostHealth,
  disableUpstreamHostCircuitForKey,
  getUpstreamHostHealth,
  normalizeUpstreamHostCircuitThreshold,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  type UpstreamHostAdmissionLease,
} from "../src/codex/upstream-host-health";'''
if old_import not in text:
    raise SystemExit("upstream reachability import anchor missing")
text = text.replace(old_import, new_import, 1)
coded_anchor = "function coded(message: string, code: string, cause?: unknown): Error {"
if coded_anchor not in text:
    raise SystemExit("coded anchor missing")
text = text.replace(coded_anchor, "beforeEach(() => clearUpstreamHostHealth());\n\n" + coded_anchor, 1)

circuit = Path("tests/upstream-host-circuit.test.ts").read_text()
start = circuit.index("function admit(")
text = text.rstrip() + "\n\n" + circuit[start:].strip() + "\n"
reach.write_text(text)

cfg = Path("tests/config-user-edits.test.ts")
cfg_text = cfg.read_text()
if "  getDefaultConfig,\n" not in cfg_text:
    cfg_text = cfg_text.replace("  getConfigPath,\n", "  getConfigPath,\n  getDefaultConfig,\n", 1)
if "  validateConfigCandidate,\n" not in cfg_text:
    cfg_text = cfg_text.replace(
        "  saveConfigPreservingClaudeCode,\n",
        "  saveConfigPreservingClaudeCode,\n  validateConfigCandidate,\n",
        1,
    )
config_tests = '''

test("upstreamHostCircuitThreshold live writes accept only integer values from 0 through 20", () => {
  for (const value of [0, 1, 20]) {
    expect(validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value }).ok).toBe(true);
  }
  for (const value of [-1, 1.5, 21, "3", null]) {
    const result = validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("upstreamHostCircuitThreshold");
  }
});

test("a malformed upstreamHostCircuitThreshold hand edit disables only the circuit and warns", () => {
  writeDiskConfig({ upstreamHostCircuitThreshold: 999 });
  const diagnostics = readConfigDiagnostics();
  expect(diagnostics.source).toBe("file");
  expect(diagnostics.config.upstreamHostCircuitThreshold).toBeUndefined();
  expect(diagnostics.warnings).toContain(
    "upstreamHostCircuitThreshold ignored: expected an integer from 0 to 20",
  );
  expect(diagnostics.config.providers.test).toBeDefined();
});
'''
if "upstreamHostCircuitThreshold live writes accept only" not in cfg_text:
    cfg_text = cfg_text.rstrip() + config_tests
cfg.write_text(cfg_text)
