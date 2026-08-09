import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CL03_LIVE_SUITES,
  createMockTransport,
  discoverLiveScenarios,
  evaluateAllApplicableRequiredPassV1,
  executeInertTool,
  expandLiveScenario,
  invokeMcpStub,
  listInertToolDefinitions,
  listLiveScenarioIds,
  loadLiveCaseAuthority,
  observationFromLiveResult,
  persistLiveResult,
  rebuildLabProjection,
  registerMcpStubTool,
  routeSubjectApplicableToRequirements,
  runLiveScenario,
  runLiveSuite,
  scenarioManifestDigest,
  subjectIdForSubject,
} from "../src/lab";
import { replayLabLedger } from "../src/lab/ledger/store";
import { clearMcpStub } from "../src/lab/live/mcp-loopback";
import { expandLiveSuiteManifest } from "../src/lab/live/suite-manifest";
import type { LabRouteContext } from "../src/lab/live/types";
import type { RouteSubjectV1 } from "../src/lab/events/types";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete process.env.OPENCODEX_HOME;
  clearMcpStub();
});

function mockRoute(overrides: Partial<LabRouteContext> = {}): LabRouteContext {
  return {
    providerId: "fixture-provider",
    clientModelId: "fixture-model",
    upstreamModelId: "fixture-model",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    baseUrl: "https://api.example.com/v1",
    labRunApproval: true,
    allowPrivateNetwork: false,
    requiredClaims: ["tools", "image", "reasoning"],
    ...overrides,
  };
}

function transportForCase(caseRecord: ReturnType<typeof discoverLiveScenarios>[number]) {
  const entries = [];
  if (caseRecord.initiatingRequest) {
    entries.push({
      status: 200,
      headers: { "content-type": caseRecord.fixture.mediaType },
      body: caseRecord.fixture.bytesUtf8,
    });
  }
  return createMockTransport({ entries });
}

describe("CL-03 live probe harness", () => {
  test("loads frozen 10-case live authority with reproducible digests", () => {
    const authority = loadLiveCaseAuthority();
    expect(authority.cases.length).toBe(10);
    const ids = authority.cases.map((c) => c.id);
    expect(ids).toContain("responses-core.live.basic-turn");
    expect(ids).toContain("mcp-core.live.synthetic-tool");
    const expandedA = expandLiveScenario(authority.cases[0]!, authority);
    const expandedB = expandLiveScenario(authority.cases[0]!, authority);
    expect(scenarioManifestDigest(expandedA)).toBe(scenarioManifestDigest(expandedB));
  });

  test("discovers all CL-03 live suites", () => {
    const authority = loadLiveCaseAuthority();
    const scenarios = discoverLiveScenarios(authority, CL03_LIVE_SUITES);
    expect(scenarios.length).toBe(10);
    expect(listLiveScenarioIds()).toHaveLength(10);
  });

  test("runs live suite with mock transport and no external network", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const route = mockRoute();
    const summary = await runLiveSuite(route, ["responses-core", "chat-core"], {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({
        entries: [
          { status: 200, body: authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!.fixture.bytesUtf8 },
          { status: 200, body: authority.cases.find((c) => c.id === "chat-core.live.basic-turn")!.fixture.bytesUtf8 },
        ],
      }),
    });
    expect(summary.total).toBe(2);
    expect(summary.results.every((r) => r.routeSubject.subjectKind === "route")).toBe(true);
  });

  test("inert tool round-trips validate args and return static results", () => {
    expect(listInertToolDefinitions().map((t) => t.name)).toContain("lookup");
    expect(executeInertTool("lookup", { q: "x" }).output).toBe("RESULT");
    expect(() => executeInertTool("lookup", { q: 1 })).toThrow();
  });

  test("MCP lab stub only — no user mcpServers", () => {
    registerMcpStubTool({ namespace: "lab", name: "echo" });
    const result = invokeMcpStub("lab", "echo", { x: 1 }, { content: [{ type: "text", text: "ECHO" }] });
    expect(result.content[0]?.text).toBe("ECHO");
  });

  test("raw URLs and secrets never appear in persisted live evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: transportForCase(caseRecord),
    });
    const { event } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("api.example.com");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("fixture-key");
    expect(event.evidenceLayer).toBe("live_route_compatibility");
    expect(event.executionMode).toBe("live");
    expect(event.subject.subjectKind).toBe("route");
  });

  test("JSONL persistence and SQLite rebuild for live evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases.find((c) => c.id === "chat-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute({
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-chat",
      surface: "responses-sse",
    }), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: transportForCase(caseRecord),
    });
    persistLiveResult(result, caseRecord, authority, { configDir: home });
    const projection = rebuildLabProjection(home);
    expect(projection.events).toBeGreaterThan(0);
    expect(projection.corruptions).toHaveLength(0);
    const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
    expect(replay.events.length).toBeGreaterThan(0);
  });

  test("route subject applicability and cross-route evidence reuse prevention", () => {
    const authority = loadLiveCaseAuthority();
    const subjectA: RouteSubjectV1 = {
      subjectSchemaVersion: 1,
      subjectKind: "route",
      providerId: "provider-a",
      providerInstanceFingerprint: "a".repeat(64),
      clientModelId: "model-a",
      upstreamModelId: "model-a",
      effectiveAdapter: "openai-responses",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
      opencodexCompatibilityVersion: "live-v1",
      behaviorFingerprint: "b".repeat(64),
      endpointFingerprint: "c".repeat(64),
      dependencies: [],
    };
    const subjectB: RouteSubjectV1 = { ...subjectA, providerId: "provider-b", endpointFingerprint: "d".repeat(64) };
    expect(subjectIdForSubject(subjectA)).not.toBe(subjectIdForSubject(subjectB));
    const caseRecord = authority.cases[0]!;
    const requirements = caseRecord.requirements;
    expect(routeSubjectApplicableToRequirements(requirements, subjectA, [])).toBe(true);
    expect(routeSubjectApplicableToRequirements(
      { ...requirements, inboundProtocols: ["anthropic-messages"] },
      subjectA,
      [],
    )).toBe(false);
  });

  test("freshness and contradictory evidence semantics for live suites", () => {
    const authority = loadLiveCaseAuthority();
    const suite = expandLiveSuiteManifest("responses-core", authority);
    expect(suite.freshness.maxAgeMs).toBe(604800000);
    expect(suite.evidenceLayer).toBe("live_route_compatibility");
    const routeSubject: RouteSubjectV1 = {
      subjectSchemaVersion: 1,
      subjectKind: "route",
      providerId: "provider-a",
      providerInstanceFingerprint: "a".repeat(64),
      clientModelId: "model-a",
      upstreamModelId: "model-a",
      effectiveAdapter: "openai-responses",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
      opencodexCompatibilityVersion: "live-v1",
      behaviorFingerprint: "b".repeat(64),
      endpointFingerprint: "c".repeat(64),
      dependencies: [],
    };
    const evalEmpty = evaluateAllApplicableRequiredPassV1(suite, [], "live", {
      subject: routeSubject,
      loadScenarioRequirements: () => ({
        inboundProtocols: ["openai-responses"],
        upstreamProtocols: ["openai-responses"],
        surfaces: ["responses-http"],
        requiredClaims: [],
        freshness: { maxAgeMs: 604800000 },
      }),
    });
    expect(evalEmpty.canVerify).toBe(false);
    expect(evalEmpty.missingRequiredScenarioIds.length).toBeGreaterThan(0);
  });

  test("timeouts classify as blockers not degraded/unsupported", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases[0]!;
    const result = await runLiveScenario(caseRecord, mockRoute({
      upstreamProtocol: "openai-responses",
    }), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({
        entries: [{ status: 200, body: "{}", error: "total_timeout" }],
      }),
    });
    expect(result.classification).toBe("timeout");
    expect(result.classification).not.toBe("protocol_failure");
  });

  test("auth failure is a blocker", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases[0]!;
    const result = await runLiveScenario(caseRecord, mockRoute({
      upstreamProtocol: "openai-responses",
    }), {
      configDir: home,
      authOutcome: "blocked",
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.classification).toBe("authentication_blocked");
  });

  test("reasoning replay exposes no private material in persisted evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases.find((c) => c.id === "reasoning-core.live.replay")!;
    const result = await runLiveScenario(caseRecord, mockRoute({
      upstreamProtocol: "openai-responses",
      requiredClaims: ["reasoning"],
    }), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({ entries: [{ status: 200, body: "{}" }] }),
    });
    const { event } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });
    expect(JSON.stringify(event)).not.toContain("PLAN");
  });
});
