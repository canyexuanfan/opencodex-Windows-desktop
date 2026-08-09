import { evaluateAssertions } from "../conformance/assertion";
import { executeScenario } from "../conformance/executor";
import type { CaseRecord, FailureClassification, FailureRule } from "../conformance/types";
import type { RouteSubjectV1 } from "../events/types";
import { createCredentialLease, LabCredentialError } from "./credential-lease";
import { createLabDestination } from "./destination";
import { expandLiveScenario } from "./manifest";
import { buildRouteSubjectV1, freezeRouteSubject } from "../subject/route-subject";
import {
  createSandboxResourceState,
  enforceSandboxLimits,
  prepareLiveSandbox,
} from "./sandbox";
import { classifyTransportError, createMockTransport, TransportError } from "./transport";
import type {
  DnsResolver,
  LabRouteContext,
  LabTransport,
  LiveRunConfig,
  LiveScenarioRunResult,
} from "./types";

export interface LiveExecutorOptions {
  transport?: LabTransport;
  resolve?: DnsResolver;
  configDir?: string;
  authOutcome?: "ok" | "blocked";
  env?: NodeJS.ProcessEnv;
}

function liveLimitsFromAuthority(caseRecord: CaseRecord, authorityLimits: Record<string, number>): LiveRunConfig {
  return {
    totalTimeoutMs: authorityLimits.totalTimeoutMs ?? 120_000,
    connectTimeoutMs: authorityLimits.connectTimeoutMs ?? 10_000,
    firstByteTimeoutMs: authorityLimits.firstByteTimeoutMs ?? 30_000,
    inactivityTimeoutMs: authorityLimits.inactivityTimeoutMs ?? 30_000,
    maxRequests: authorityLimits.maxRequests ?? 16,
    maxInputBytes: authorityLimits.maxInputBytes ?? 8 * 1024 * 1024,
    maxOutputBytes: authorityLimits.maxOutputBytes ?? 16 * 1024 * 1024,
    maxOutputTokens: authorityLimits.maxOutputTokens ?? 32_768,
    maxToolCalls: authorityLimits.maxToolCalls ?? 32,
    maxMemoryBytes: authorityLimits.maxMemoryBytes ?? 512 * 1024 * 1024,
    maxChildProcesses: authorityLimits.maxChildProcesses ?? 0,
    maxArtifacts: authorityLimits.maxArtifacts ?? 16,
    perArtifactBytes: authorityLimits.perArtifactBytes ?? 256 * 1024,
    aggregateArtifactBytes: authorityLimits.aggregateArtifactBytes ?? 1024 * 1024,
  };
}

function checkRoutePreconditions(routeContext: LabRouteContext, caseRecord: CaseRecord): string | null {
  for (const precondition of caseRecord.requirements.routePreconditions) {
    if (precondition === "lab_run_approval" && routeContext.labRunApproval !== true) {
      return "route_precondition_unmet:lab_run_approval";
    }
    if (precondition === "allow_private_network" && routeContext.allowPrivateNetwork !== true) {
      return "route_precondition_unmet:allow_private_network";
    }
  }
  for (const claim of caseRecord.requirements.requiredClaims) {
    if (!(routeContext.requiredClaims ?? []).includes(claim)) {
      return `required_claim_missing:${claim}`;
    }
  }
  return null;
}

function transportFromFixtures(caseRecord: CaseRecord): LabTransport {
  const entries = [];
  if (caseRecord.initiatingRequest && caseRecord.fixture.role === "upstream_response") {
    entries.push({
      status: 200,
      headers: { "content-type": caseRecord.fixture.mediaType },
      body: caseRecord.fixture.bytesUtf8,
    });
  } else if (caseRecord.fixture.role === "upstream_response") {
    entries.push({
      status: 200,
      headers: { "content-type": caseRecord.fixture.mediaType },
      body: caseRecord.fixture.bytesUtf8,
    });
  } else if (caseRecord.fixture.role === "adapter_vector" || caseRecord.fixture.role === "client_request") {
    entries.push({ status: 200, body: caseRecord.fixture.bytesUtf8 });
  } else if (caseRecord.fixture.role === "synthetic_tool") {
    entries.push({ status: 200, body: "{}" });
  }
  return createMockTransport({ entries });
}

function classifyWithFailureRules(
  rules: FailureRule[],
  signal: string,
  defaultClass: FailureClassification,
  defaultCode: string,
): { classification: FailureClassification; secondaryCode: string } {
  for (const rule of rules) {
    if (rule.match.includes(signal) || rule.match.includes("no_prior_rule")) {
      if (rule.match.includes("no_prior_rule") && signal !== "no_prior_rule") continue;
      if (!rule.match.includes(signal) && !rule.match.includes("no_prior_rule")) continue;
      return {
        classification: rule.classification,
        secondaryCode: rule.secondaryCode ?? defaultCode,
      };
    }
  }
  return { classification: defaultClass, secondaryCode: defaultCode };
}

async function executeLiveObservation(
  caseRecord: CaseRecord,
  transport: LabTransport,
  limits: LiveRunConfig,
): Promise<{ observation: Awaited<ReturnType<typeof executeScenario>> }> {
  const state = createSandboxResourceState();
  if (caseRecord.fixture.role !== "adapter_vector" && caseRecord.fixture.role !== "synthetic_tool") {
    const response = await transport.request({
      method: "POST",
      path: "/chat/completions",
      body: caseRecord.initiatingRequest?.bytesUtf8 ?? caseRecord.fixture.bytesUtf8,
    });
    enforceSandboxLimits(state, limits, {
      requests: 1,
      inputBytes: (caseRecord.initiatingRequest?.bytesUtf8 ?? caseRecord.fixture.bytesUtf8).length,
      outputBytes: response.body.length,
    });
  }
  const observation = await executeScenario(caseRecord);
  return { observation };
}

/** Run one live scenario against a route context with injectable transport. */
export async function runLiveScenario(
  caseRecord: CaseRecord,
  routeContext: LabRouteContext,
  opts: LiveExecutorOptions = {},
): Promise<LiveScenarioRunResult> {
  const diagnostics: string[] = [];
  const startedAt = Date.now();
  const complete = (
    partial: Omit<LiveScenarioRunResult, "startedAt" | "completedAt">,
  ): LiveScenarioRunResult => ({
    ...partial,
    startedAt,
    completedAt: Math.max(startedAt, Date.now()),
  });

  try {
    prepareLiveSandbox(opts.env);
    const destination = await createLabDestination({
      baseUrl: routeContext.baseUrl,
      allowPrivateNetwork: routeContext.allowPrivateNetwork,
      labRunApproval: routeContext.labRunApproval,
      resolve: opts.resolve,
      configDir: opts.configDir,
    });
    const routeSubject = freezeRouteSubject(
      buildRouteSubjectV1(routeContext, destination, opts.configDir),
    );
    const preconditionFailure = checkRoutePreconditions(routeContext, caseRecord);
    if (preconditionFailure) {
      return complete({
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: false,
        classification: "inconclusive",
        secondaryCode: preconditionFailure,
        assertionResults: [],
        diagnostics: [preconditionFailure],
        routeSubject,
      });
    }

    const lease = createCredentialLease({
      destination,
      authOutcome: opts.authOutcome ?? "ok",
    });
    void lease;

    const authority = await import("./manifest").then((m) => m.loadLiveCaseAuthority());
    const expanded = expandLiveScenario(caseRecord, authority);
    const limits = liveLimitsFromAuthority(caseRecord, expanded.executionLimits as Record<string, number>);
    const transport = opts.transport ?? transportFromFixtures(caseRecord);

    const { observation } = await executeLiveObservation(caseRecord, transport, limits);
    const assertionResults = evaluateAssertions(caseRecord.assertions, observation);
    const requiredFailures = assertionResults.filter((r) => r.required && !r.passed);

    if (caseRecord.expectedFailure) {
      const listed = caseRecord.expectedFailure.assertionIds;
      const controlPassed = listed.every((id) => assertionResults.find((r) => r.id === id)?.passed === true);
      const expectedFailureMatched = controlPassed && requiredFailures.length === 0;
      return complete({
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: expectedFailureMatched,
        classification: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedClass as FailureClassification
          : "protocol_failure",
        secondaryCode: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedCode
          : "deterministic_assertion",
        assertionResults,
        diagnostics,
        routeSubject,
      });
    }

    const passed = requiredFailures.length === 0;
    const failureRules = expanded.failureRules as FailureRule[];
    const signal = passed ? "pass" : "required_assertion_failed";
    const classified = passed
      ? { classification: "inconclusive" as FailureClassification, secondaryCode: "pass" }
      : classifyWithFailureRules(failureRules, signal, "protocol_failure", "deterministic_assertion");

    return complete({
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed,
      classification: passed ? "inconclusive" : classified.classification,
      secondaryCode: passed ? undefined : classified.secondaryCode,
      assertionResults,
      diagnostics,
      routeSubject,
    });
  } catch (error) {
    diagnostics.push(String(error));
    if (error instanceof LabCredentialError || (error instanceof Error && error.name === "LabCredentialError")) {
      const credError = error as LabCredentialError;
      return complete({
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: false,
        classification: "authentication_blocked",
        secondaryCode: credError.code,
        assertionResults: [],
        diagnostics,
        routeSubject: fallbackRouteSubject(routeContext),
        transportError: "auth_blocked",
      });
    }
    const transportCode = error instanceof TransportError
      || (error instanceof Error && error.name === "TransportError")
      ? (error as TransportError).code
      : undefined;
    const classified = classifyTransportError(error);
    return complete({
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed: false,
      classification: classified.classification,
      secondaryCode: classified.secondaryCode,
      assertionResults: [],
      diagnostics,
      routeSubject: fallbackRouteSubject(routeContext),
      transportError: transportCode,
    });
  }
}

function fallbackRouteSubject(routeContext: LabRouteContext): RouteSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: routeContext.providerId,
    providerInstanceFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    clientModelId: routeContext.clientModelId,
    upstreamModelId: routeContext.upstreamModelId,
    effectiveAdapter: routeContext.effectiveAdapter,
    inboundProtocol: routeContext.inboundProtocol,
    upstreamProtocol: routeContext.upstreamProtocol,
    surface: routeContext.surface,
    opencodexCompatibilityVersion: "live-v1",
    behaviorFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    endpointFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    dependencies: [],
  };
}
