import { evaluateAssertions } from "../conformance/assertion";
import { emptyObservation, finalizeObservation, setClientResponse } from "../conformance/observation";
import { normalizeSseBytes } from "../conformance/sse-normalize";
import type { CaseRecord, FailureClassification, FailureRule, NormalizedEvent, NormalizedObservation } from "../conformance/types";
import type { RouteSubjectV1 } from "../events/types";
import { isTrustedLabRouteExecutor } from "../../lib/lab-live-execution-authority";
import { buildRouteSubjectV1 } from "../subject/route-subject";
import { createLabDestination, LabDestinationError } from "./destination";
import { expandLiveScenario } from "./manifest";
import { createSandboxResourceState, enforceSandboxLimits, LabSandboxError, prepareLiveSandbox } from "./sandbox";
import { classifyTransportError, TransportError } from "./transport";
import type { DnsResolver, LabRouteContext, LabTransport, LiveExecutionAuthority, LiveRunConfig, LiveScenarioRunResult, TrustedLabRouteExecutor } from "./types";

export interface LiveExecutorOptions {
  /** Branded exact-route capability for evidence-eligible production execution. */
  routeExecutor?: TrustedLabRouteExecutor;
  /** Test-only byte transport. Results are deliberately not evidence-eligible. */
  transport?: LabTransport;
  resolve?: DnsResolver;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
}

function liveLimitsFromAuthority(authorityLimits: Record<string, number>): LiveRunConfig {
  return {
    totalTimeoutMs: authorityLimits.totalTimeoutMs ?? 120_000, connectTimeoutMs: authorityLimits.connectTimeoutMs ?? 10_000,
    firstByteTimeoutMs: authorityLimits.firstByteTimeoutMs ?? 30_000, inactivityTimeoutMs: authorityLimits.inactivityTimeoutMs ?? 30_000,
    maxRequests: authorityLimits.maxRequests ?? 16, maxInputBytes: authorityLimits.maxInputBytes ?? 8 * 1024 * 1024,
    maxOutputBytes: authorityLimits.maxOutputBytes ?? 16 * 1024 * 1024, maxOutputTokens: authorityLimits.maxOutputTokens ?? 32_768,
    maxToolCalls: authorityLimits.maxToolCalls ?? 32, maxMemoryBytes: authorityLimits.maxMemoryBytes ?? 512 * 1024 * 1024,
    maxChildProcesses: authorityLimits.maxChildProcesses ?? 0, maxArtifacts: authorityLimits.maxArtifacts ?? 16,
    perArtifactBytes: authorityLimits.perArtifactBytes ?? 256 * 1024, aggregateArtifactBytes: authorityLimits.aggregateArtifactBytes ?? 1024 * 1024,
  };
}

export function isLiveCaseApplicableToRoute(caseRecord: CaseRecord, route: LabRouteContext): boolean {
  const req = caseRecord.requirements;
  if (!req.inboundProtocols.includes(route.inboundProtocol) || !req.upstreamProtocols.includes(route.upstreamProtocol) || !req.surfaces.includes(route.surface)) return false;
  if (req.platforms.length > 0 && !req.platforms.includes(process.platform)) return false;
  if (!req.requiredClaims.every((claim) => (route.requiredClaims ?? []).includes(claim))) return false;
  if (!req.requiredHarnessFeatures.every((feature) => (route.availableHarnessFeatures ?? []).includes(feature))) return false;
  return true;
}

function routePreconditionFailure(route: LabRouteContext, caseRecord: CaseRecord): string | null {
  for (const precondition of caseRecord.requirements.routePreconditions) {
    if (precondition === "lab_run_approval" && route.labRunApproval !== true) return "route_precondition_unmet:lab_run_approval";
    if (precondition === "allow_private_network" && route.allowPrivateNetwork !== true) return "route_precondition_unmet:allow_private_network";
  }
  return null;
}

function classifyWithFailureRules(rules: FailureRule[], signal: string): { classification: FailureClassification; secondaryCode: string } {
  const rule = rules.find((row) => row.match.includes(signal));
  return rule ? { classification: rule.classification, secondaryCode: rule.secondaryCode ?? signal }
    : { classification: "inconclusive", secondaryCode: "unclassified" };
}

function pathForProtocol(protocol: string): string {
  if (protocol === "openai-chat") return "/chat/completions";
  if (protocol === "anthropic-messages") return "/messages";
  return "/responses";
}

function chatObservation(body: string, status: number): NormalizedObservation {
  const observation = emptyObservation();
  const output: unknown[] = [];
  let text = "";
  let terminal = false;
  const trimmed = body.trimStart();
  if (trimmed.startsWith("data:")) {
    const toolParts = new Map<number, { id: string; name: string; arguments: string }>();
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const line = frame.split(/\r?\n/).find((row) => row.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") { if (payload === "[DONE]") terminal = true; continue; }
      let json: any;
      try { json = JSON.parse(payload); } catch { continue; }
      for (const choice of Array.isArray(json.choices) ? json.choices : []) {
        if (typeof choice?.delta?.content === "string") text += choice.delta.content;
        if (choice?.finish_reason != null) terminal = true;
        for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
          const idx = Number.isInteger(call?.index) ? call.index : toolParts.size;
          const prior = toolParts.get(idx) ?? { id: "", name: "", arguments: "" };
          if (typeof call?.id === "string") prior.id = call.id;
          if (typeof call?.function?.name === "string") prior.name = call.function.name;
          if (typeof call?.function?.arguments === "string") prior.arguments += call.function.arguments;
          toolParts.set(idx, prior);
        }
      }
    }
    for (const row of [...toolParts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)) {
      output.push({ type: "function_call", call_id: row.id, name: row.name, arguments: row.arguments });
    }
  } else {
    const json = JSON.parse(body) as any;
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (typeof choice?.message?.content === "string") text = choice.message.content;
    terminal = choice?.finish_reason != null;
    for (const call of Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []) {
      output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments });
    }
  }
  if (text) output.unshift({ type: "message", content: [{ type: "output_text", text }] });
  const json = { status: terminal ? "completed" : "incomplete", output };
  const events: NormalizedEvent[] = terminal ? [{ event: "response.completed", data: { response: json }, ordinal: 0 }] : [];
  finalizeObservation(observation, events, json, status);
  return observation;
}

function responsesObservation(body: string, status: number): NormalizedObservation {
  const observation = emptyObservation();
  const trimmed = body.trimStart();
  if (trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    const events = normalizeSseBytes(new TextEncoder().encode(body), "openai-responses");
    finalizeObservation(observation, events, null, status);
    return observation;
  }
  const json = JSON.parse(body) as Record<string, unknown>;
  finalizeObservation(observation, [], json, status);
  const state = typeof json.status === "string" ? json.status : undefined;
  if (state === "completed" || state === "failed" || state === "incomplete") {
    setClientResponse(observation, { terminal: state === "completed" ? "completed" : state });
  }
  return observation;
}

function normalizeTransportObservation(route: LabRouteContext, response: { status: number; body: string }): NormalizedObservation {
  const observation = route.upstreamProtocol === "openai-chat" ? chatObservation(response.body, response.status) : responsesObservation(response.body, response.status);
  if (route.surface.startsWith("anthropic-") && observation.client.response.terminal === "completed") {
    setClientResponse(observation, { terminal: "message_stop" });
  }
  return observation;
}

async function withTotalTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TransportError("total_timeout", "live scenario total timeout")), timeoutMs);
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
  } finally { clearTimeout(timer); }
}

export async function runLiveScenario(caseRecord: CaseRecord, routeContext: LabRouteContext, opts: LiveExecutorOptions = {}): Promise<LiveScenarioRunResult> {
  const diagnostics: string[] = [];
  const startedAt = Date.now();
  let routeSubject: RouteSubjectV1 | undefined;
  let executionAuthority: LiveExecutionAuthority = "none";
  const complete = (partial: Omit<LiveScenarioRunResult, "startedAt" | "completedAt" | "executionAuthority">): LiveScenarioRunResult => ({ ...partial, executionAuthority, startedAt, completedAt: Math.max(startedAt, Date.now()) });
  try {
    const environment = prepareLiveSandbox(opts.env);
    if (!isLiveCaseApplicableToRoute(caseRecord, routeContext)) {
      return complete({ scenarioId: caseRecord.id, suite: caseRecord.suite, passed: false, classification: "inconclusive", secondaryCode: "scenario_inapplicable", assertionResults: [], diagnostics, routeSubject });
    }
    const destination = await createLabDestination({ baseUrl: routeContext.baseUrl, allowPrivateNetwork: routeContext.allowPrivateNetwork, labRunApproval: routeContext.labRunApproval, resolve: opts.resolve, configDir: opts.configDir });
    routeSubject = buildRouteSubjectV1(routeContext, destination, opts.configDir);
    const preconditionFailure = routePreconditionFailure(routeContext, caseRecord);
    if (preconditionFailure) {
      return complete({ scenarioId: caseRecord.id, suite: caseRecord.suite, passed: false, classification: "inconclusive", secondaryCode: preconditionFailure, assertionResults: [], diagnostics: [preconditionFailure], routeSubject });
    }
    const authority = await import("./manifest").then((m) => m.loadLiveCaseAuthority());
    const expanded = expandLiveScenario(caseRecord, authority);
    const limits = liveLimitsFromAuthority(expanded.executionLimits as Record<string, number>);
    const state = createSandboxResourceState();
    let observation: NormalizedObservation;
    if (opts.routeExecutor) {
      if (!isTrustedLabRouteExecutor(opts.routeExecutor)) throw new TransportError("untrusted_route_executor", "untrusted route executor capability");
      executionAuthority = "trusted_route";
      observation = await withTotalTimeout(limits.totalTimeoutMs, (signal) => opts.routeExecutor!.execute({ routeContext, destination, routeSubject: routeSubject!, scenarioId: caseRecord.id, initiatingRequest: caseRecord.initiatingRequest?.bytesUtf8, limits, signal, environment }));
    } else if (opts.transport && caseRecord.initiatingRequest) {
      executionAuthority = "test_transport";
      const body = caseRecord.initiatingRequest.bytesUtf8;
      const inputBytes = new TextEncoder().encode(body).byteLength;
      enforceSandboxLimits(state, limits, { requests: 1, inputBytes });
      const response = await withTotalTimeout(limits.totalTimeoutMs, (signal) => opts.transport!.request({ method: "POST", path: pathForProtocol(routeContext.upstreamProtocol), body, signal }));
      if (response.status === 401 || response.status === 403) throw new TransportError("auth_blocked", `HTTP ${response.status}`);
      if (response.status === 429) throw new TransportError("quota_blocked", "HTTP 429");
      if (response.status === 451) throw new TransportError("region_blocked", "HTTP 451");
      if (response.status >= 500) throw new TransportError("provider_transient", `HTTP ${response.status}`);
      const outputBytes = new TextEncoder().encode(response.body).byteLength;
      enforceSandboxLimits(state, limits, { outputBytes, outputTokens: Math.ceil(outputBytes / 4) });
      observation = normalizeTransportObservation(routeContext, response);
    } else {
      throw new TransportError("live_transport_required", caseRecord.initiatingRequest ? "live transport or trusted route executor required" : "trusted route executor required");
    }
    const assertionResults = evaluateAssertions(caseRecord.assertions, observation);
    const requiredFailures = assertionResults.filter((row) => row.required && !row.passed);
    const failureRules = expanded.failureRules as FailureRule[];
    if (caseRecord.expectedFailure) {
      const matched = caseRecord.expectedFailure.assertionIds.every((id) => assertionResults.find((row) => row.id === id)?.passed === true) && requiredFailures.length === 0;
      return complete({ scenarioId: caseRecord.id, suite: caseRecord.suite, passed: matched, classification: matched ? caseRecord.expectedFailure.expectedClass : "protocol_failure", secondaryCode: matched ? caseRecord.expectedFailure.expectedCode : "deterministic_assertion", assertionResults, diagnostics, routeSubject });
    }
    const passed = requiredFailures.length === 0;
    const classified = passed ? { classification: "inconclusive" as FailureClassification, secondaryCode: "pass" } : classifyWithFailureRules(failureRules, "required_assertion_failed");
    return complete({ scenarioId: caseRecord.id, suite: caseRecord.suite, passed, classification: passed ? "inconclusive" : classified.classification, secondaryCode: passed ? undefined : classified.secondaryCode, assertionResults, diagnostics, routeSubject });
  } catch (error) {
    diagnostics.push(error instanceof Error ? `${error.name}:${error.message}` : String(error));
    let classified = classifyTransportError(error);
    if (error instanceof LabSandboxError) classified = { classification: error.code === "harness_failure" ? "harness_failure" : "budget_exhausted", secondaryCode: error.code };
    if (error instanceof LabDestinationError) classified = { classification: error.code === "network_blocked" ? "network_failure" : "harness_failure", secondaryCode: error.code };
    return complete({ scenarioId: caseRecord.id, suite: caseRecord.suite, passed: false, classification: classified.classification, secondaryCode: classified.secondaryCode, assertionResults: [], diagnostics, routeSubject, transportError: error instanceof TransportError ? error.code : undefined });
  }
}
