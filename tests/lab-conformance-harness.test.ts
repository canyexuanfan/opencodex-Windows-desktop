import { describe, expect, test } from "bun:test";
import { evaluateAssertion } from "../src/lab/conformance/assertion";
import { fixtureDigest, scenarioManifestDigest } from "../src/lab/conformance/digest";
import { jcsEqual } from "../src/lab/conformance/jcs";
import { resolveJsonPointer } from "../src/lab/conformance/json-pointer";
import { runScenario } from "../src/lab/conformance/executor";
import {
  discoverScenarios,
  expandScenario,
  loadCaseAuthority,
  validateExpandedFixtureRef,
  validateFixtureDigests,
  validateScenarioManifestDigest,
} from "../src/lab/conformance/manifest";
import { executeMcpSyntheticAction } from "../src/lab/conformance/mcp-stub";
import { buildNegativeControls, NEGATIVE_CONTROL_FIXTURES } from "../src/lab/conformance/negative-controls";
import { emptyObservation } from "../src/lab/conformance/observation";
import {
  listScenarioIds,
  runConformanceSuite,
  runNegativeControls,
} from "../src/lab/conformance/runner";
import { CL01_SUITES, SYNTHETIC_MARKER } from "../src/lab/conformance/types";
import { normalizeSseBytes } from "../src/lab/conformance/sse-normalize";

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

  test("expanded scenario manifests include synthetic provenance", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const expanded = expandScenario(scenario, authority);
    const fixtures = expanded.fixtures as Array<Record<string, unknown>>;
    expect(fixtures[0].syntheticMarker).toBe(SYNTHETIC_MARKER);
    expect((fixtures[0].provenance as { kind: string }).kind).toBe("lab_authored");
    expect((fixtures[0].provenance as { authority: string }).authority).toBe("022_protocol_v1_cases.json");
    expect((fixtures[0].provenance as { sourceCommit: string }).sourceCommit).toBe(authority.sourceCommit);
    const digest = scenarioManifestDigest(expanded);
    expect(digest).toHaveLength(64);
  });

  test("rejects forged synthetic provenance metadata", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const expanded = expandScenario(scenario, authority);
    const fixtures = expanded.fixtures as Array<Record<string, unknown>>;
    const forged = { ...fixtures[0], syntheticMarker: "forged" };
    const errors = validateExpandedFixtureRef(forged, authority, scenario.fixture.bytesUtf8);
    expect(errors.some((e) => e.includes("syntheticMarker"))).toBe(true);
    const badCommit = {
      ...fixtures[0],
      provenance: { ...(fixtures[0].provenance as object), sourceCommit: "deadbeef" },
    };
    expect(validateExpandedFixtureRef(badCommit, authority, scenario.fixture.bytesUtf8).length).toBeGreaterThan(0);
  });
});

describe("CL-01 SSE normalization", () => {
  test("openai-chat recognizes [DONE] sentinel only for chat protocol", () => {
    const bytes = new TextEncoder().encode("data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
    const chatEvents = normalizeSseBytes(bytes, "openai-chat");
    expect(chatEvents.some((e) => e.event === "[DONE]")).toBe(true);
    const responsesEvents = normalizeSseBytes(bytes, "openai-responses");
    expect(responsesEvents.some((e) => e.event === "[DONE]")).toBe(false);
    const anthropicEvents = normalizeSseBytes(bytes, "anthropic-messages");
    expect(anthropicEvents.some((e) => e.event === "[DONE]")).toBe(false);
  });
});

describe("CL-01 MCP deterministic actions", () => {
  test("all four MCP protocol scenarios pass closed action semantics", async () => {
    const authority = loadCaseAuthority();
    const mcpScenarios = authority.cases.filter((c) => c.suite === "mcp-core");
    expect(mcpScenarios.length).toBe(4);
    for (const scenario of mcpScenarios) {
      const observation = executeMcpSyntheticAction(scenario);
      for (const assertion of scenario.assertions) {
        const result = evaluateAssertion(assertion, observation);
        expect(result.passed).toBe(true);
      }
    }
  });
});

describe("CL-01 expanded scenario manifests are stable", () => {
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
