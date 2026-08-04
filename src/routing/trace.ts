/**
 * Route decision trace: bounded, versioned, privacy-safe evidence of WHY a
 * provider/model/account was selected for a request (RI-01).
 *
 * Contract rules (devlog/_plan/260804_router_intelligence/000_master_plan.md):
 * - One trace per routing decision; fallback EXECUTION attempts stay in the
 *   usage entry's existing `attempts[]` array, never in this trace.
 * - Never persists prompts, message bodies, tool payloads, credentials,
 *   authorization headers, raw quota responses, or hidden reasoning.
 * - Stable wire values only; no localized strings.
 * - Deterministic bounds: candidates <= 8, exclusions per candidate <= 16,
 *   requirements <= 16, strings <= 128 chars, serialized trace <= 16 KiB.
 * - Truncation is explicit: `truncated` flags are set whenever a limit was
 *   enforced.
 */

import { randomBytes } from "node:crypto";

export type RouteDecisionKind =
  | "explicit-account"
  | "explicit-provider"
  | "native"
  | "combo"
  | "policy"
  | "default-provider";

export type Unknownable = number | boolean | "unknown";

export interface RouteRequirementEvidence {
  /** Stable wire code, e.g. "min-context-window" | "tools" | "image-input". */
  id: string;
  expected?: string | number | boolean;
  actual?: Unknownable | string;
  outcome: "satisfied" | "unsatisfied" | "unknown";
}

export interface RouteExclusionReason {
  /** Stable wire code, e.g. "cooldown" | "disabled" | "cost-limit". */
  code: string;
  detail?: string;
}

export interface RouteCapabilityEvidence {
  contextWindow?: number;
  tools?: Unknownable;
  image?: Unknownable;
  structuredOutput?: Unknownable;
  reasoningEfforts?: string[];
  serviceTier?: string | "unknown";
  localOnly?: Unknownable;
  remoteAllowed?: Unknownable;
  encryptedCodexTasks?: Unknownable;
}

export interface RouteHealthEvidence {
  cooldownUntilMs?: number;
  softAvoidUntilMs?: number;
  successRate?: number;
  failures?: number;
  incompleteStreamRate?: number;
  recentLatencyMs?: number;
  sampleCount?: number;
  recencyWeight?: number;
}

export interface RouteQuotaEvidence {
  known: boolean;
  headroomTokens?: number;
  exhausted?: boolean;
  resetAtMs?: number;
  reauthOrCooling?: boolean;
  reservedHeadroomTokens?: number;
  /** Stable wire code for the evidence source (e.g. "provider-report"). */
  source?: string;
}

export interface RouteCostEvidence {
  estimatedUsd?: number;
  /** Stable wire code for the price source (e.g. "registry" | "expected"). */
  priceSource?: string;
  incomplete?: boolean;
  limitUsd?: number;
  excludedByLimit?: boolean;
}

export interface RouteScoreEvidence {
  total: number;
  components: {
    capability?: number;
    health?: number;
    quota?: number;
    cost?: number;
    latency?: number;
    configuredPriority?: number;
  };
}

export interface RouteCandidateTrace {
  provider: string;
  model: string;
  accountRef?: string;
  eligible: boolean;
  exclusions: RouteExclusionReason[];
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
  score?: RouteScoreEvidence;
}

export interface RouteDecisionTraceV1 {
  version: 1;
  decisionId: string;
  createdAt: number;
  requestedModel: string;
  routeKind: RouteDecisionKind;
  profile?: { id: string; revision: string };
  requirements: RouteRequirementEvidence[];
  candidates: RouteCandidateTrace[];
  selected: {
    candidateIndex: number;
    provider: string;
    model: string;
    accountRef?: string;
    reason: string;
    tieBreak?: string;
  };
  truncated?: {
    candidates?: true;
    exclusions?: true;
    strings?: true;
  };
}

export const MAX_TRACE_CANDIDATES = 8;
export const MAX_EXCLUSIONS_PER_CANDIDATE = 16;
export const MAX_REQUIREMENTS = 16;
export const MAX_TRACE_STRING = 128;
export const MAX_TRACE_BYTES = 16 * 1024;

const ROUTE_KINDS = new Set<RouteDecisionKind>([
  "explicit-account",
  "explicit-provider",
  "native",
  "combo",
  "policy",
  "default-provider",
]);

const REQUIREMENT_OUTCOMES = new Set(["satisfied", "unsatisfied", "unknown"]);

function capString(value: string, budget: { strings?: true }): string {
  if (value.length <= MAX_TRACE_STRING) return value;
  budget.strings = true;
  return value.slice(0, MAX_TRACE_STRING);
}

function capOptionalString(value: string | undefined, budget: { strings?: true }): string | undefined {
  if (value === undefined) return undefined;
  return capString(value, budget);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownable(value: unknown): Unknownable | undefined {
  if (typeof value === "boolean") return value;
  if (finiteNumber(value)) return value;
  if (value === "unknown") return "unknown";
  return undefined;
}

export interface TraceCandidateInput {
  provider: string;
  model: string;
  accountRef?: string;
  eligible: boolean;
  exclusions: RouteExclusionReason[];
  score?: RouteScoreEvidence;
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
}

export interface TraceBuildInput {
  requestedModel: string;
  routeKind: RouteDecisionKind;
  selected: {
    provider: string;
    model: string;
    accountRef?: string;
    reason: string;
    tieBreak?: string;
    /** Index into `candidates`; defaults to 0. */
    candidateIndex?: number;
  };
  profile?: { id: string; revision: string };
  requirements?: RouteRequirementEvidence[];
  candidates?: TraceCandidateInput[];
  now?: number;
}

function buildCandidate(input: TraceCandidateInput, budget: { strings?: true; exclusions?: true }): RouteCandidateTrace {
  const exclusions = input.exclusions.slice(0, MAX_EXCLUSIONS_PER_CANDIDATE);
  if (exclusions.length < input.exclusions.length) budget.exclusions = true;
  return {
    provider: capString(input.provider, budget),
    model: capString(input.model, budget),
    ...(input.accountRef !== undefined
      ? { accountRef: capString(input.accountRef, budget) }
      : {}),
    eligible: input.eligible,
    exclusions: exclusions.map(exclusion => ({
      code: capString(exclusion.code, budget),
      ...(exclusion.detail !== undefined
        ? { detail: capString(exclusion.detail, budget) }
        : {}),
    })),
    ...(input.score ? { score: input.score } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.health ? { health: input.health } : {}),
    ...(input.quota ? { quota: input.quota } : {}),
    ...(input.cost ? { cost: input.cost } : {}),
  };
}

function buildRequirement(requirement: RouteRequirementEvidence, budget: { strings?: true }): RouteRequirementEvidence {
  return {
    id: capString(requirement.id, budget),
    ...(requirement.expected !== undefined
      ? { expected: typeof requirement.expected === "string"
          ? capString(requirement.expected, budget)
          : requirement.expected }
      : {}),
    ...(requirement.actual !== undefined
      ? { actual: typeof requirement.actual === "string"
          ? capString(requirement.actual, budget)
          : requirement.actual }
      : {}),
    outcome: requirement.outcome,
  };
}

/**
 * Build a bounded decision trace. The builder never receives credentials: callers
 * pass provider/model NAME strings and opaque account references only.
 */
export function buildRouteDecisionTrace(input: TraceBuildInput): RouteDecisionTraceV1 {
  const budget: { strings?: true; exclusions?: true; candidates?: true } = {};
  const now = input.now ?? Date.now();
  const truncated: RouteDecisionTraceV1["truncated"] = {};
  let selectedIndex = Number.isInteger(input.selected.candidateIndex ?? 0)
    ? (input.selected.candidateIndex ?? 0)
    : 0;

  let candidates = (input.candidates ?? []).map(candidate => buildCandidate(candidate, budget));
  if (candidates.length > MAX_TRACE_CANDIDATES) {
    // Keep the selected candidate even when it sits beyond the slice: a trace
    // whose selected candidate vanished would contradict the decision.
    candidates = selectedIndex < MAX_TRACE_CANDIDATES
      ? candidates.slice(0, MAX_TRACE_CANDIDATES)
      : [...candidates.slice(0, MAX_TRACE_CANDIDATES - 1), candidates[selectedIndex]!];
    selectedIndex = Math.min(selectedIndex, candidates.length - 1);
    truncated.candidates = true;
  }
  if (candidates.length === 0) {
    // Invariant: every decision names at least the selected route as a candidate.
    candidates = [{
      provider: capString(input.selected.provider, budget),
      model: capString(input.selected.model, budget),
      ...(input.selected.accountRef !== undefined
        ? { accountRef: capString(input.selected.accountRef, budget) }
        : {}),
      eligible: true,
      exclusions: [],
    }];
  }

  let requirements = (input.requirements ?? []).map(requirement => buildRequirement(requirement, budget));
  if (requirements.length > MAX_REQUIREMENTS) {
    requirements = requirements.slice(0, MAX_REQUIREMENTS);
    truncated.candidates = true;
  }

  if (selectedIndex < 0 || selectedIndex >= candidates.length) selectedIndex = 0;

  const trace: RouteDecisionTraceV1 = {
    version: 1,
    decisionId: randomBytes(6).toString("hex"),
    createdAt: now,
    requestedModel: capString(input.requestedModel, budget),
    routeKind: input.routeKind,
    ...(input.profile
      ? {
        profile: {
          id: capString(input.profile.id, budget),
          revision: capString(input.profile.revision, budget),
        },
      }
      : {}),
    requirements,
    candidates,
    selected: {
      candidateIndex: selectedIndex,
      provider: capString(input.selected.provider, budget),
      model: capString(input.selected.model, budget),
      ...(input.selected.accountRef !== undefined
        ? { accountRef: capString(input.selected.accountRef, budget) }
        : {}),
      reason: capString(input.selected.reason, budget),
      ...(input.selected.tieBreak !== undefined
        ? { tieBreak: capString(input.selected.tieBreak, budget) }
        : {}),
    },
  };

  if (budget.strings) truncated.strings = true;
  if (budget.exclusions) truncated.exclusions = true;
  if (budget.candidates) truncated.candidates = true;
  if (Object.keys(truncated).length > 0) trace.truncated = truncated;

  return enforceByteBudget(trace);
}

/** Deterministic byte-budget enforcement: drop details, then shrink candidates. */
function enforceByteBudget(trace: RouteDecisionTraceV1): RouteDecisionTraceV1 {
  let serialized = JSON.stringify(trace);
  if (serialized.length <= MAX_TRACE_BYTES) return trace;
  const truncated = { ...trace.truncated, strings: true as const };
  const candidates = trace.candidates.map(candidate => ({
    ...candidate,
    exclusions: candidate.exclusions.map(exclusion => ({ code: exclusion.code })),
  }));
  const slimmed: RouteDecisionTraceV1 = { ...trace, truncated, candidates };
  serialized = JSON.stringify(slimmed);
  if (serialized.length <= MAX_TRACE_BYTES) return slimmed;
  return {
    ...slimmed,
    truncated: { ...truncated, candidates: true as const },
    candidates: slimmed.candidates.slice(0, Math.max(1, Math.floor(MAX_TRACE_CANDIDATES / 2))),
  };
}

// ---- defensive parsing of persisted rows --------------------------------------

function parseExclusion(raw: unknown): RouteExclusionReason | null {
  if (!isPlainRecord(raw)) return null;
  const code = raw.code;
  if (typeof code !== "string" || code.length === 0) return null;
  return {
    code: code.slice(0, MAX_TRACE_STRING),
    ...(typeof raw.detail === "string"
      ? { detail: raw.detail.slice(0, MAX_TRACE_STRING) }
      : {}),
  };
}

function parseRequirement(raw: unknown): RouteRequirementEvidence | null {
  if (!isPlainRecord(raw)) return null;
  const id = raw.id;
  const outcome = raw.outcome;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof outcome !== "string" || !REQUIREMENT_OUTCOMES.has(outcome)) return null;
  return {
    id: id.slice(0, MAX_TRACE_STRING),
    ...(typeof raw.expected === "string"
      ? { expected: raw.expected.slice(0, MAX_TRACE_STRING) }
      : typeof raw.expected === "number" || typeof raw.expected === "boolean"
        ? { expected: raw.expected }
        : {}),
    ...(typeof raw.actual === "string"
      ? { actual: raw.actual.slice(0, MAX_TRACE_STRING) }
      : unknownable(raw.actual) !== undefined
        ? { actual: unknownable(raw.actual) }
        : {}),
    outcome: outcome as RouteRequirementEvidence["outcome"],
  };
}

function parseCapability(raw: unknown): RouteCapabilityEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteCapabilityEvidence = {};
  if (finiteNumber(raw.contextWindow)) out.contextWindow = raw.contextWindow;
  const tools = unknownable(raw.tools);
  if (tools !== undefined) out.tools = tools;
  const image = unknownable(raw.image);
  if (image !== undefined) out.image = image;
  const structuredOutput = unknownable(raw.structuredOutput);
  if (structuredOutput !== undefined) out.structuredOutput = structuredOutput;
  if (Array.isArray(raw.reasoningEfforts)
    && raw.reasoningEfforts.every((value): value is string => typeof value === "string")) {
    out.reasoningEfforts = raw.reasoningEfforts
      .slice(0, 8)
      .map(value => value.slice(0, MAX_TRACE_STRING));
  }
  if (raw.serviceTier === "unknown") {
    out.serviceTier = "unknown";
  } else if (typeof raw.serviceTier === "string" && raw.serviceTier) {
    out.serviceTier = raw.serviceTier.slice(0, MAX_TRACE_STRING);
  }
  const localOnly = unknownable(raw.localOnly);
  if (localOnly !== undefined) out.localOnly = localOnly;
  const remoteAllowed = unknownable(raw.remoteAllowed);
  if (remoteAllowed !== undefined) out.remoteAllowed = remoteAllowed;
  const encryptedCodexTasks = unknownable(raw.encryptedCodexTasks);
  if (encryptedCodexTasks !== undefined) out.encryptedCodexTasks = encryptedCodexTasks;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseHealth(raw: unknown): RouteHealthEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteHealthEvidence = {};
  if (finiteNumber(raw.cooldownUntilMs)) out.cooldownUntilMs = raw.cooldownUntilMs;
  if (finiteNumber(raw.softAvoidUntilMs)) out.softAvoidUntilMs = raw.softAvoidUntilMs;
  if (finiteNumber(raw.successRate)) out.successRate = raw.successRate;
  if (finiteNumber(raw.failures)) out.failures = raw.failures;
  if (finiteNumber(raw.incompleteStreamRate)) out.incompleteStreamRate = raw.incompleteStreamRate;
  if (finiteNumber(raw.recentLatencyMs)) out.recentLatencyMs = raw.recentLatencyMs;
  if (finiteNumber(raw.sampleCount)) out.sampleCount = raw.sampleCount;
  if (finiteNumber(raw.recencyWeight)) out.recencyWeight = raw.recencyWeight;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseQuota(raw: unknown): RouteQuotaEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (typeof raw.known !== "boolean") return undefined;
  const out: RouteQuotaEvidence = { known: raw.known };
  if (finiteNumber(raw.headroomTokens)) out.headroomTokens = raw.headroomTokens;
  if (typeof raw.exhausted === "boolean") out.exhausted = raw.exhausted;
  if (finiteNumber(raw.resetAtMs)) out.resetAtMs = raw.resetAtMs;
  if (typeof raw.reauthOrCooling === "boolean") out.reauthOrCooling = raw.reauthOrCooling;
  if (finiteNumber(raw.reservedHeadroomTokens)) out.reservedHeadroomTokens = raw.reservedHeadroomTokens;
  if (typeof raw.source === "string" && raw.source) {
    out.source = raw.source.slice(0, MAX_TRACE_STRING);
  }
  return out;
}

function parseCost(raw: unknown): RouteCostEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteCostEvidence = {};
  if (finiteNumber(raw.estimatedUsd)) out.estimatedUsd = raw.estimatedUsd;
  if (typeof raw.priceSource === "string" && raw.priceSource) {
    out.priceSource = raw.priceSource.slice(0, MAX_TRACE_STRING);
  }
  if (typeof raw.incomplete === "boolean") out.incomplete = raw.incomplete;
  if (finiteNumber(raw.limitUsd)) out.limitUsd = raw.limitUsd;
  if (typeof raw.excludedByLimit === "boolean") out.excludedByLimit = raw.excludedByLimit;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseScore(raw: unknown): RouteScoreEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (!finiteNumber(raw.total)) return undefined;
  const components = isPlainRecord(raw.components) ? raw.components : {};
  const parsedComponents: RouteScoreEvidence["components"] = {};
  for (const key of ["capability", "health", "quota", "cost", "latency", "configuredPriority"] as const) {
    if (finiteNumber(components[key])) parsedComponents[key] = components[key];
  }
  return { total: raw.total, components: parsedComponents };
}

function parseCandidate(raw: unknown): RouteCandidateTrace | null {
  if (!isPlainRecord(raw)) return null;
  const provider = raw.provider;
  const model = raw.model;
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  if (typeof raw.eligible !== "boolean") return null;
  const exclusions = Array.isArray(raw.exclusions)
    ? raw.exclusions.map(parseExclusion).filter((value): value is RouteExclusionReason => value !== null)
    : [];
  return {
    provider: provider.slice(0, MAX_TRACE_STRING),
    model: model.slice(0, MAX_TRACE_STRING),
    ...(typeof raw.accountRef === "string"
      ? { accountRef: raw.accountRef.slice(0, MAX_TRACE_STRING) }
      : {}),
    eligible: raw.eligible,
    exclusions: exclusions.slice(0, MAX_EXCLUSIONS_PER_CANDIDATE),
    ...(parseCapability(raw.capability) ? { capability: parseCapability(raw.capability) } : {}),
    ...(parseHealth(raw.health) ? { health: parseHealth(raw.health) } : {}),
    ...(parseQuota(raw.quota) ? { quota: parseQuota(raw.quota) } : {}),
    ...(parseCost(raw.cost) ? { cost: parseCost(raw.cost) } : {}),
    ...(parseScore(raw.score) ? { score: parseScore(raw.score) } : {}),
  };
}

/**
 * Defensive parse of a persisted trace. Returns null when the row is not a
 * version-1 trace; otherwise returns a bounded, whitelisted copy. Invalid
 * evidence objects are dropped rather than poisoning the DTO.
 */
export function normalizeRouteDecisionTrace(raw: unknown): RouteDecisionTraceV1 | null {
  if (!isPlainRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const decisionId = raw.decisionId;
  const createdAt = raw.createdAt;
  const requestedModel = raw.requestedModel;
  const routeKind = raw.routeKind;
  if (typeof decisionId !== "string" || decisionId.length === 0) return null;
  if (!finiteNumber(createdAt)) return null;
  if (typeof requestedModel !== "string" || requestedModel.length === 0) return null;
  if (typeof routeKind !== "string" || !ROUTE_KINDS.has(routeKind as RouteDecisionKind)) return null;
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) return null;

  const candidates = raw.candidates
    .map(parseCandidate)
    .filter((value): value is RouteCandidateTrace => value !== null)
    .slice(0, MAX_TRACE_CANDIDATES);
  if (candidates.length === 0) return null;

  const selected = isPlainRecord(raw.selected) ? raw.selected : null;
  if (!selected) return null;
  const selectedProvider = selected.provider;
  const selectedModel = selected.model;
  const selectedReason = selected.reason;
  if (typeof selectedProvider !== "string" || typeof selectedModel !== "string") return null;
  if (typeof selectedReason !== "string") return null;
  const candidateIndex = Number.isInteger(selected.candidateIndex)
    ? selected.candidateIndex as number
    : 0;
  if (candidateIndex < 0 || candidateIndex >= candidates.length) return null;

  const requirements = Array.isArray(raw.requirements)
    ? raw.requirements.map(parseRequirement)
      .filter((value): value is RouteRequirementEvidence => value !== null)
      .slice(0, MAX_REQUIREMENTS)
    : [];

  const profile = isPlainRecord(raw.profile)
    && typeof raw.profile.id === "string"
    && typeof raw.profile.revision === "string"
    ? {
      id: raw.profile.id.slice(0, MAX_TRACE_STRING),
      revision: raw.profile.revision.slice(0, MAX_TRACE_STRING),
    }
    : undefined;

  const truncated = isPlainRecord(raw.truncated)
    ? {
      ...(raw.truncated.candidates === true ? { candidates: true as const } : {}),
      ...(raw.truncated.exclusions === true ? { exclusions: true as const } : {}),
      ...(raw.truncated.strings === true ? { strings: true as const } : {}),
    }
    : undefined;

  return {
    version: 1,
    decisionId: decisionId.slice(0, MAX_TRACE_STRING),
    createdAt,
    requestedModel: requestedModel.slice(0, MAX_TRACE_STRING),
    routeKind: routeKind as RouteDecisionKind,
    ...(profile ? { profile } : {}),
    requirements,
    candidates,
    selected: {
      candidateIndex,
      provider: selectedProvider.slice(0, MAX_TRACE_STRING),
      model: selectedModel.slice(0, MAX_TRACE_STRING),
      ...(typeof selected.accountRef === "string"
        ? { accountRef: selected.accountRef.slice(0, MAX_TRACE_STRING) }
        : {}),
      reason: selectedReason.slice(0, MAX_TRACE_STRING),
      ...(typeof selected.tieBreak === "string"
        ? { tieBreak: selected.tieBreak.slice(0, MAX_TRACE_STRING) }
        : {}),
    },
    ...(truncated && Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
}
