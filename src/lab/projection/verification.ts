import type { ObservationEvent, ProtocolSubjectV1 } from "../events/types";
import type { ExecutionMode } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";

export interface VerificationEvaluation {
  applicableRequiredScenarioIds: string[];
  passingRequiredScenarioIds: string[];
  missingRequiredScenarioIds: string[];
  canVerify: boolean;
  notes: string[];
}

export type LoadScenarioManifest = (digest: string) => Record<string, unknown> | null;

/** Live-reserved scenarios are inapplicable in fixture-mode protocol conformance. */
export function isScenarioApplicable(
  scenarioId: string,
  executionMode: ExecutionMode,
  evidenceLayer: string,
): boolean {
  if (evidenceLayer === "protocol_conformance" && executionMode === "fixture") {
    if (scenarioId.includes(".live.")) return false;
  }
  return true;
}

function scenarioApplicableToRequirements(
  requirements: { inboundProtocols?: string[]; upstreamProtocols?: string[]; surfaces?: string[] },
  subject: ProtocolSubjectV1,
): boolean {
  const inbound = requirements.inboundProtocols ?? [];
  const upstream = requirements.upstreamProtocols ?? [];
  const surfaces = requirements.surfaces ?? [];
  return (
    inbound.includes(subject.inboundProtocol) &&
    upstream.includes(subject.upstreamProtocol) &&
    surfaces.includes(subject.surface)
  );
}

function scenarioApplicableToProtocolSubject(
  scenarioManifest: Record<string, unknown> | null,
  subject: ProtocolSubjectV1,
): boolean {
  if (!scenarioManifest) return false;
  const req = scenarioManifest.requirements;
  if (!req || typeof req !== "object") return false;
  const inbound = (req as { inboundProtocols?: string[] }).inboundProtocols ?? [];
  const upstream = (req as { upstreamProtocols?: string[] }).upstreamProtocols ?? [];
  const surfaces = (req as { surfaces?: string[] }).surfaces ?? [];
  return (
    inbound.includes(subject.inboundProtocol) &&
    upstream.includes(subject.upstreamProtocol) &&
    surfaces.includes(subject.surface)
  );
}

export function newestObservationByScenario(
  observations: ObservationEvent[],
): Map<string, ObservationEvent> {
  const byScenario = new Map<string, ObservationEvent>();
  const ordered = [...observations].sort((a, b) => {
    if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
  for (const obs of ordered) {
    byScenario.set(obs.scenarioId, obs);
  }
  return byScenario;
}

/**
 * Evaluate `all-applicable-required-pass-v1` per frozen CL-00 semantics.
 * Positive VERIFIED requires a non-empty applicable required set and a current
 * pass for every applicable required scenario.
 */
export type LoadScenarioRequirements = (digest: string) => {
  inboundProtocols?: string[];
  upstreamProtocols?: string[];
  surfaces?: string[];
} | null;

export function evaluateAllApplicableRequiredPassV1(
  suiteManifest: SuiteManifestV1,
  observations: ObservationEvent[],
  executionMode: ExecutionMode,
  opts: {
    subject?: ProtocolSubjectV1;
    loadScenarioManifest?: LoadScenarioManifest;
    loadScenarioRequirements?: LoadScenarioRequirements;
  } = {},
): VerificationEvaluation {
  const notes: string[] = [];
  if (suiteManifest.verificationRule !== "all-applicable-required-pass-v1") {
    return {
      applicableRequiredScenarioIds: [],
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [],
      canVerify: false,
      notes: ["unsupported_verification_rule"],
    };
  }

  const requiredScenarios = suiteManifest.scenarios.filter((s) => s.role === "required");
  const applicableRequired: string[] = [];
  const unavailableManifests: string[] = [];

  for (const s of requiredScenarios) {
    if (!isScenarioApplicable(s.id, executionMode, suiteManifest.evidenceLayer)) continue;
    if (suiteManifest.evidenceLayer === "protocol_conformance" && opts.subject) {
      const scenarioManifest = opts.loadScenarioManifest?.(s.manifestDigest) ?? null;
      if (scenarioManifest) {
        if (!scenarioApplicableToProtocolSubject(scenarioManifest, opts.subject)) continue;
      } else {
        const requirements = opts.loadScenarioRequirements?.(s.manifestDigest) ?? null;
        if (!requirements) {
          unavailableManifests.push(s.id);
          continue;
        }
        if (!scenarioApplicableToRequirements(requirements, opts.subject)) continue;
      }
    }
    applicableRequired.push(s.id);
  }
  applicableRequired.sort();

  if (unavailableManifests.length > 0) {
    return {
      applicableRequiredScenarioIds: applicableRequired,
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [...new Set([...applicableRequired, ...unavailableManifests])].sort(),
      canVerify: false,
      notes: unavailableManifests.map((id) => `scenario_manifest_unavailable:${id}`),
    };
  }

  if (applicableRequired.length === 0) {
    return {
      applicableRequiredScenarioIds: [],
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [],
      canVerify: false,
      notes: ["empty_applicable_required_set"],
    };
  }

  const newest = newestObservationByScenario(observations);
  const passing: string[] = [];
  const missing: string[] = [];

  for (const scenarioId of applicableRequired) {
    const scenarioRef = requiredScenarios.find((s) => s.id === scenarioId)!;
    const obs = newest.get(scenarioId);
    if (!obs) {
      missing.push(scenarioId);
      continue;
    }
    if (obs.scenarioManifestDigest !== scenarioRef.manifestDigest) {
      missing.push(scenarioId);
      notes.push(`digest_mismatch:${scenarioId}`);
      continue;
    }
    if (obs.outcome !== "pass") {
      missing.push(scenarioId);
      continue;
    }
    passing.push(scenarioId);
  }

  return {
    applicableRequiredScenarioIds: applicableRequired,
    passingRequiredScenarioIds: passing,
    missingRequiredScenarioIds: missing,
    canVerify: missing.length === 0 && passing.length === applicableRequired.length,
    notes,
  };
}

export function parseSuiteManifestFromArtifact(parsed: unknown): SuiteManifestV1 | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.id !== "string" || typeof raw.version !== "string") return null;
  if (typeof raw.verificationRule !== "string") return null;
  if (!Array.isArray(raw.scenarios)) return null;
  const scenarios = raw.scenarios.map((s) => {
    if (!s || typeof s !== "object") return null;
    const row = s as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.version !== "string") return null;
    if (typeof row.role !== "string" || typeof row.manifestDigest !== "string") return null;
    return {
      id: row.id,
      version: row.version,
      role: row.role as SuiteManifestV1["scenarios"][number]["role"],
      manifestDigest: row.manifestDigest,
    };
  });
  if (scenarios.some((s) => s === null)) return null;
  return {
    schemaVersion: 1,
    id: raw.id,
    version: raw.version,
    evidenceLayer: String(raw.evidenceLayer ?? ""),
    capability: String(raw.capability ?? ""),
    assertionDslVersion: String(raw.assertionDslVersion ?? ""),
    evidenceSchemaVersion: String(raw.evidenceSchemaVersion ?? ""),
    freshness:
      raw.freshness && typeof raw.freshness === "object"
        ? { maxAgeMs: (raw.freshness as { maxAgeMs?: number | null }).maxAgeMs ?? null }
        : { maxAgeMs: null },
    contradictionRule: String(raw.contradictionRule ?? ""),
    scenarios: scenarios as SuiteManifestV1["scenarios"],
    verificationRule: raw.verificationRule,
  };
}
