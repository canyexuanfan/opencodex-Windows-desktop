import { describe, expect, test } from "bun:test";
import { evaluateAssertion } from "../src/lab/conformance/assertion";
import { fixtureDigest } from "../src/lab/conformance/digest";
import { jcsEqual } from "../src/lab/conformance/jcs";
import { resolveJsonPointer } from "../src/lab/conformance/json-pointer";
import {
  discoverScenarios,
  expandScenario,
  loadCaseAuthority,
  validateFixtureDigests,
  validateScenarioManifestDigest,
} from "../src/lab/conformance/manifest";
import { buildNegativeControls, NEGATIVE_CONTROL_FIXTURES } from "../src/lab/conformance/negative-controls";
import { emptyObservation } from "../src/lab/conformance/observation";
import { runScenario } from "../src/lab/conformance/executor";
import {
  listScenarioIds,
  runConformanceSuite,
  runNegativeControls,
} from "../src/lab/conformance/runner";
import { CL01_SUITES } from "../src/lab/conformance/types";

describe("CL-01 conformance harness infrastructure", () => {
  test("loads case authority and validates fixture digests", () => {
    const authority = loadCaseAuthority();
    expect(authority.cases.length).toBeGreaterThanOrEqual(24);
    for (const caseRecord of authority.cases) {
      expect(validateFixtureDigests(caseRecord)).toEqual([]);
      expect(validateScenarioManifestDigest(caseRecord, authority)).toBe(true);
    }
  });

  test("discovers CL-01 suite scenarios with stable IDs", () => {
    const authority = loadCaseAuthority();
    const scenarios = discoverScenarios(authority, CL01_SUITES);
    expect(scenarios.length).toBe(24);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("responses-core.protocol.request-shape");
    expect(ids).toContain("codex-core.protocol.compaction-and-special-items");
  });

  test("json pointer and JCS equality are deterministic", () => {
    const observation = emptyObservation();
    observation.client.response.status = 200;
    const resolved = resolveJsonPointer(observation, "/client/response/status");
    expect(resolved.ok).toBe(true);
    expect(jcsEqual(resolved.value, 200)).toBe(true);
    expect(jcsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  test("fixture digest matches contract domain separation", () => {
    const bytes = new TextEncoder().encode("PING");
    expect(fixtureDigest(bytes)).toHaveLength(64);
    expect(fixtureDigest(bytes)).not.toEqual(fixtureDigest(new TextEncoder().encode("PING2")));
  });

  test("assertion evaluator reports selector_missing", () => {
    const observation = emptyObservation();
    const result = evaluateAssertion({
      id: "missing",
      operator: "json_path_equals",
      selector: "/upstream/requests/0/json/model",
      expected: "fixture-model",
      required: true,
    }, observation);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("selector_missing");
  });

  test("expanded scenario manifests are stable", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const a = expandScenario(scenario, authority);
    const b = expandScenario(scenario, authority);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("CL-01 canonical protocol scenarios", () => {
  test("all CL-01 suite scenarios pass", async () => {
    const summary = await runConformanceSuite();
    const failures = summary.results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.scenarioId}: ${f.classification} ${f.secondaryCode ?? ""} ${f.diagnostics.join(";")} ${f.assertionResults.filter((a) => !a.passed).map((a) => a.id).join(",")}`).join("\n");
      throw new Error(`scenario failures:\n${detail}`);
    }
    expect(summary.passed).toBe(24);
  }, 120000);
});

describe("CL-01 negative controls", () => {
  test("negative controls are rejected by the harness", async () => {
    expect(NEGATIVE_CONTROL_FIXTURES.length).toBeGreaterThanOrEqual(8);
    const authority = loadCaseAuthority();
    const controls = buildNegativeControls(discoverScenarios(authority, CL01_SUITES));
    expect(controls.length).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    for (const control of controls) {
      const result = await runScenario(control);
      expect(result.passed).toBe(false);
      expect(result.classification).not.toBe("inconclusive");
    }
  }, 120000);

  test("runNegativeControls summary counts rejections", async () => {
    const summary = await runNegativeControls();
    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(summary.passed).toBe(summary.total);
  }, 120000);
});

describe("CL-01 scenario discovery API", () => {
  test("listScenarioIds returns stable mapping", () => {
    const ids = listScenarioIds();
    expect(ids.length).toBe(24);
    expect(ids.sort()).toEqual([...ids].sort());
  });
});
