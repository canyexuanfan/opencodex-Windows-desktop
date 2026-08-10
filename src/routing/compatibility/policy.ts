import type { CompatibilityVerdict } from "../../lab/constants";
import { queryLabCatalog } from "../../lab/query/catalog";
import type { NormalizedRoutingProfileCompatibility } from "../profile";
import type {
  CandidateCompatibilityEvidence,
  CompatibilityEvaluationOutcome,
} from "./types";
import { COMPATIBILITY_UNKNOWN_PENALTY_SCORE, MAX_TRACE_COMPATIBILITY_SUITES } from "./types";
import type { RouteCompatibilityEvidence } from "../trace";

function positiveThresholdMet(
  verdict: CompatibilityVerdict,
  minStatus: "PROBED" | "VERIFIED" | undefined,
): boolean {
  if (!minStatus) return true;
  if (minStatus === "PROBED") return verdict === "PROBED" || verdict === "VERIFIED";
  return verdict === "VERIFIED";
}

function effectiveMaxAgeMs(
  suiteId: string,
  evidenceLayer: string,
  profileMaxAgeMs: number | undefined,
): number | null {
  const catalog = queryLabCatalog({
    suiteId,
    layer: evidenceLayer as "protocol_conformance" | "live_route_compatibility",
  });
  const entry = catalog.find(row => row.suiteId === suiteId && row.evidenceLayer === evidenceLayer);
  const ages: number[] = [];
  if (entry?.freshness?.maxAgeMs != null && typeof entry.freshness.maxAgeMs === "number") {
    ages.push(entry.freshness.maxAgeMs);
  }
  if (profileMaxAgeMs != null) ages.push(profileMaxAgeMs);
  if (ages.length === 0) return null;
  return Math.min(...ages);
}

function mergePenalty(current: number | null, next: number | null): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return Math.min(current, next);
}

function applyUnknownPolicy(
  policy: NormalizedRoutingProfileCompatibility["unknownEvidence"],
  code: string,
  detail: string,
): Pick<CompatibilityEvaluationOutcome, "exclusions" | "penaltyScore"> {
  if (policy === "exclude") {
    return { exclusions: [{ code, detail }], penaltyScore: null };
  }
  if (policy === "penalize") {
    return { exclusions: [], penaltyScore: COMPATIBILITY_UNKNOWN_PENALTY_SCORE };
  }
  return { exclusions: [], penaltyScore: null };
}

export function evaluateCompatibilityForCandidate(
  policy: NormalizedRoutingProfileCompatibility | undefined,
  evidence: CandidateCompatibilityEvidence | undefined,
  now = Date.now(),
): CompatibilityEvaluationOutcome & { trace?: RouteCompatibilityEvidence } {
  const outcome: CompatibilityEvaluationOutcome = {
    exclusions: [],
    penaltyScore: null,
    suiteTraces: [],
  };
  if (!policy || policy.requiredSuites.length === 0) return outcome;

  let penaltyScore: number | null = null;
  for (const requirement of policy.requiredSuites) {
    if (outcome.suiteTraces.length >= MAX_TRACE_COMPATIBILITY_SUITES) break;

    const maxAgeMs = effectiveMaxAgeMs(
      requirement.suiteId,
      requirement.evidenceLayer,
      policy.maxEvidenceAgeMs,
    );
    const row = evidence?.suites.find(
      suite => suite.suiteId === requirement.suiteId && suite.evidenceLayer === requirement.evidenceLayer,
    );
    const fresh = row ? (maxAgeMs === null || now - row.asOf <= maxAgeMs) : false;
    const verdict = row?.verdict;

    const trace = {
      suiteId: requirement.suiteId,
      evidenceLayer: requirement.evidenceLayer,
      ...(verdict ? { verdict } : {}),
      ...(policy.minStatus ? { minStatus: policy.minStatus } : {}),
      fresh,
      unknownPolicy: policy.unknownEvidence,
      degradedPolicy: policy.degradedEvidence,
      outcome: "unknown" as const,
    };

    if (!evidence?.subjectResolved) {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      outcome.suiteTraces.push({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore ? "penalized" : "unknown",
        reason: "subject-unresolved",
      });
      continue;
    }

    if (!evidence.projectionAvailable) {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      outcome.suiteTraces.push({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore ? "penalized" : "unknown",
        reason: "projection-unavailable",
      });
      continue;
    }

    if (!row || !fresh) {
      const applied = applyUnknownPolicy(
        policy.unknownEvidence,
        fresh === false && row ? "compatibility-stale" : "compatibility-unknown",
        requirement.suiteId,
      );
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      outcome.suiteTraces.push({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore ? "penalized" : "unknown",
        reason: !row ? "missing-evidence" : "stale-evidence",
      });
      continue;
    }

    if (verdict === "UNSUPPORTED") {
      outcome.exclusions.push({ code: "compatibility-unsupported", detail: requirement.suiteId });
      outcome.suiteTraces.push({ ...trace, outcome: "excluded", reason: "unsupported" });
      continue;
    }

    if (verdict === "DEGRADED") {
      if (policy.degradedEvidence === "exclude") {
        outcome.exclusions.push({ code: "compatibility-degraded", detail: requirement.suiteId });
        outcome.suiteTraces.push({ ...trace, outcome: "excluded", reason: "degraded" });
      } else if (policy.degradedEvidence === "penalize") {
        penaltyScore = mergePenalty(penaltyScore, COMPATIBILITY_UNKNOWN_PENALTY_SCORE);
        outcome.suiteTraces.push({ ...trace, outcome: "penalized", reason: "degraded" });
      } else {
        outcome.suiteTraces.push({ ...trace, outcome: "satisfied", reason: "degraded-allowed" });
      }
      continue;
    }

    if (verdict === "UNKNOWN" || verdict === "CLAIMED" || verdict === "BLOCKED") {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      outcome.suiteTraces.push({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore ? "penalized" : "unknown",
        reason: verdict.toLowerCase(),
      });
      continue;
    }

    if (!positiveThresholdMet(verdict!, policy.minStatus)) {
      outcome.exclusions.push({ code: "compatibility-insufficient", detail: requirement.suiteId });
      outcome.suiteTraces.push({ ...trace, outcome: "excluded", reason: "below-min-status" });
      continue;
    }

    outcome.suiteTraces.push({ ...trace, outcome: "satisfied", reason: "threshold-met" });
  }

  outcome.penaltyScore = penaltyScore;
  const trace: RouteCompatibilityEvidence = {
    ...(evidence?.subjectId ? { subjectIdPrefix: evidence.subjectId.slice(0, 16) } : {}),
    suites: outcome.suiteTraces,
  };
  return { ...outcome, trace };
}
