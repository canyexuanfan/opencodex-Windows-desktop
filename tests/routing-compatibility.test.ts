import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import { evaluateCompatibilityForCandidate } from "../src/routing/compatibility/policy";
import { loadCompatibilityEvidenceSnapshot } from "../src/routing/compatibility/reader";
import { resolvePolicyRouteSubject } from "../src/routing/compatibility/subject";
import { subjectIdForSubject } from "../src/lab/digest";
import { getRoutingProfile, normalizeRoutingProfile } from "../src/routing/profile";
import { resetCompatibilityVersionCacheForTests } from "../src/routing/compatibility/version";
import type { OcxConfig } from "../src/types";
import type { CandidateCompatibilityEvidence } from "../src/routing/compatibility/types";

const COMPAT_VERSION = "f".repeat(64);

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-responses", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    routingProfiles: {
      legacy: {
        candidates: [{ provider: "a", model: "m1" }],
        require: { tools: true },
      },
      compat: {
        candidates: [{ provider: "a", model: "m1" }],
        compatibility: {
          requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
          minStatus: "PROBED",
          unknownEvidence: "exclude",
          degradedEvidence: "penalize",
        },
      },
    },
    ...overrides,
  };
}

function routed(provider: OcxConfig["providers"][string]) {
  return { ...provider };
}

function evidence(verdict: CandidateCompatibilityEvidence["suites"][number]["verdict"], asOf = Date.now()): CandidateCompatibilityEvidence {
  return {
    subjectResolved: true,
    projectionAvailable: true,
    subjectId: "s".repeat(64),
    suites: [{
      suiteId: "responses-core",
      evidenceLayer: "live_route_compatibility",
      verdict,
      asOf,
      fresh: true,
      notes: [],
    }],
  };
}

const policy = getRoutingProfile(baseConfig(), "compat")!.compatibility!;

beforeEach(() => {
  process.env.OCX_COMPATIBILITY_VERSION = COMPAT_VERSION;
  resetCompatibilityVersionCacheForTests();
});

afterEach(() => {
  delete process.env.OCX_COMPATIBILITY_VERSION;
  resetCompatibilityVersionCacheForTests();
});

describe("CL-06 routing compatibility", () => {
  test("legacy profile without compatibility retains pre-CL-06 behavior", () => {
    const config = baseConfig();
    const legacy = getRoutingProfile(config, "legacy")!;
    expect(legacy.compatibility).toBeUndefined();
    const result = evaluatePolicyProfile(config, "legacy", {}, [{
      provider: "a",
      model: "m1",
      capability: { tools: true, contextWindow: 200000 },
    }]);
    expect(result.selectedIndex).toBe(0);
    expect(result.candidates[0]?.exclusions).toEqual([]);
  });

  test("legacy profile revision stability when compatibility omitted", () => {
    const config = baseConfig();
    const revision = getRoutingProfile(config, "legacy")!.revision;
    const again = normalizeRoutingProfile("legacy", config.routingProfiles!.legacy!);
    expect(again.revision).toBe(revision);
    expect(again.compatibility).toBeUndefined();
  });

  test("exact route identity changes when adapter changes", () => {
    const config = baseConfig();
    const a = resolvePolicyRouteSubject(config, "a", "m1", routed(config.providers.a!));
    const b = resolvePolicyRouteSubject(config, "b", "m2", routed(config.providers.b!));
    expect(a?.subjectId).toBeDefined();
    expect(b?.subjectId).toBeDefined();
    expect(a!.subjectId).not.toBe(b!.subjectId);
  });

  test("VERIFIED satisfies minimum PROBED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "PROBED" }, evidence("VERIFIED"));
    expect(out.exclusions).toEqual([]);
  });

  test("VERIFIED satisfies minimum VERIFIED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "VERIFIED" }, evidence("VERIFIED"));
    expect(out.exclusions).toEqual([]);
  });

  test("PROBED satisfies minimum PROBED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "PROBED" }, evidence("PROBED"));
    expect(out.exclusions).toEqual([]);
  });

  test("PROBED fails minimum VERIFIED", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, minStatus: "VERIFIED" }, evidence("PROBED"));
    expect(out.exclusions.some(row => row.code === "compatibility-insufficient")).toBe(true);
  });

  test("UNSUPPORTED excludes required suite", () => {
    const out = evaluateCompatibilityForCandidate(policy, evidence("UNSUPPORTED"));
    expect(out.exclusions.some(row => row.code === "compatibility-unsupported")).toBe(true);
  });

  test("DEGRADED allow behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "allow" }, evidence("DEGRADED"));
    expect(out.exclusions).toEqual([]);
    expect(out.penaltyScore).toBeNull();
  });

  test("DEGRADED penalize behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "penalize" }, evidence("DEGRADED"));
    expect(out.exclusions).toEqual([]);
    expect(out.penaltyScore).toBe(0.3);
  });

  test("DEGRADED exclude behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, degradedEvidence: "exclude" }, evidence("DEGRADED"));
    expect(out.exclusions.some(row => row.code === "compatibility-degraded")).toBe(true);
  });

  test("UNKNOWN allow behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "allow" }, evidence("UNKNOWN"));
    expect(out.exclusions).toEqual([]);
  });

  test("UNKNOWN penalize behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "penalize" }, evidence("UNKNOWN"));
    expect(out.penaltyScore).toBe(0.3);
  });

  test("UNKNOWN exclude behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "exclude" }, evidence("UNKNOWN"));
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("CLAIMED follows unknown-evidence behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "exclude" }, evidence("CLAIMED"));
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("BLOCKED follows unknown-evidence behavior", () => {
    const out = evaluateCompatibilityForCandidate({ ...policy, unknownEvidence: "penalize" }, evidence("BLOCKED"));
    expect(out.penaltyScore).toBe(0.3);
  });

  test("stale positive evidence does not satisfy policy", () => {
    const stale = evidence("VERIFIED", Date.now() - 30 * 24 * 60 * 60 * 1000);
    const out = evaluateCompatibilityForCandidate(
      { ...policy, minStatus: "VERIFIED", maxEvidenceAgeMs: 60_000 },
      stale,
    );
    expect(out.exclusions.length).toBeGreaterThan(0);
  });

  test("missing Lab projection does not crash evaluation", () => {
    const out = evaluateCompatibilityForCandidate(policy, {
      subjectResolved: true,
      projectionAvailable: false,
      suites: [],
    });
    expect(out.exclusions.some(row => row.code === "compatibility-unknown")).toBe(true);
  });

  test("incompatible projection is treated as unavailable without rebuild", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cl06-"));
    try {
      const snap = loadCompatibilityEvidenceSnapshot(["missing-subject"], home);
      expect(snap.projectionAvailable).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("policy evaluation does not import live probe executors", async () => {
    const mod = await import("../src/routing/compatibility/policy");
    expect(Object.keys(mod)).not.toContain("runLiveScenario");
  });

  test("bounded evidence lookup uses one snapshot for many subjects", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cl06-"));
    try {
      const ids = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(64));
      const snap = loadCompatibilityEvidenceSnapshot(ids, home);
      expect(snap.bySubject.size).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("assemblePolicyCandidateEvidence uses a single snapshot read site", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/routing/compatibility/assemble.ts")).text();
    const matches = source.match(/loadCompatibilityEvidenceSnapshot\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("dry-run and production evaluator parity with same evidence", () => {
    const config = baseConfig();
    const input = [{
      provider: "a",
      model: "m1",
      capability: { tools: true, contextWindow: 200000 },
      compatibility: evidence("VERIFIED"),
    }];
    const a = evaluatePolicyProfile(config, "compat", {}, input);
    const b = evaluatePolicyProfile(config, "compat", {}, input);
    expect(a.selectedIndex).toBe(b.selectedIndex);
    expect(a.candidates[0]?.exclusions).toEqual(b.candidates[0]?.exclusions);
  });

  test("compatibility exclusions appear in route traces", () => {
    const config = baseConfig();
    const result = evaluatePolicyProfile(config, "compat", {}, [{
      provider: "a",
      model: "m1",
      capability: { tools: true, contextWindow: 200000 },
      compatibility: evidence("UNSUPPORTED"),
    }]);
    expect(result.trace.candidates[0]?.exclusions.some(row => row.code === "compatibility-unsupported")).toBe(true);
    expect(result.trace.candidates[0]?.compatibility?.suites.length).toBeGreaterThan(0);
  });

  test("trace bounds remain enforced for compatibility suites", () => {
    const suites = Array.from({ length: 12 }, (_, i) => ({
      suiteId: `suite-${i}`,
      evidenceLayer: "live_route_compatibility" as const,
      verdict: "VERIFIED" as const,
      asOf: Date.now(),
      fresh: true,
      notes: [],
    }));
    const out = evaluateCompatibilityForCandidate({
      ...policy,
      requiredSuites: suites.map(row => ({ suiteId: row.suiteId, evidenceLayer: row.evidenceLayer })),
    }, {
      subjectResolved: true,
      projectionAvailable: true,
      suites,
    });
    expect(out.suiteTraces.length).toBeLessThanOrEqual(8);
  });

  test("compatibility profile revision changes only when compatibility changes", () => {
    const base = getRoutingProfile(baseConfig(), "compat")!.revision;
    const noCompat = normalizeRoutingProfile("legacy", baseConfig().routingProfiles!.legacy!);
    expect(noCompat.revision).not.toBe(base);
    const same = normalizeRoutingProfile("compat", baseConfig().routingProfiles!.compat!);
    expect(same.revision).toBe(base);
  });

  test("subject id is stable for frozen route subject", () => {
    const subject = {
      subjectSchemaVersion: 1 as const,
      subjectKind: "route" as const,
      providerId: "a",
      providerInstanceFingerprint: "a".repeat(64),
      clientModelId: "m1",
      upstreamModelId: "m1",
      effectiveAdapter: "openai-responses",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
      opencodexCompatibilityVersion: COMPAT_VERSION,
      behaviorFingerprint: "b".repeat(64),
      endpointFingerprint: "c".repeat(64),
      dependencies: [],
    };
    expect(subjectIdForSubject(subject)).toBe(subjectIdForSubject({ ...subject }));
  });
});
