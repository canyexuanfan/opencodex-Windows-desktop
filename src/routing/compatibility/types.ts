import type { CompatibilityVerdict, EvidenceLayer } from "../../lab/constants";
import type { OcxRoutingUnknownEvidenceMode } from "../../types";

export interface CompatibilitySuiteRequirement {
  suiteId: string;
  evidenceLayer: EvidenceLayer;
}

export interface NormalizedCompatibilityPolicy {
  requiredSuites: CompatibilitySuiteRequirement[];
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence: OcxRoutingUnknownEvidenceMode;
  degradedEvidence: OcxRoutingUnknownEvidenceMode;
}

export interface ObservedSuiteVerdict {
  suiteId: string;
  evidenceLayer: EvidenceLayer;
  verdict: CompatibilityVerdict;
  asOf: number;
  fresh: boolean;
  notes: string[];
}

export interface CandidateCompatibilityEvidence {
  subjectId?: string;
  subjectResolved: boolean;
  projectionAvailable: boolean;
  suites: ObservedSuiteVerdict[];
}

export interface CompatibilityEvaluationOutcome {
  exclusions: Array<{ code: string; detail?: string }>;
  penaltyScore: number | null;
  suiteTraces: Array<{
    suiteId: string;
    evidenceLayer: EvidenceLayer;
    verdict?: CompatibilityVerdict;
    minStatus?: "PROBED" | "VERIFIED";
    fresh?: boolean;
    unknownPolicy?: OcxRoutingUnknownEvidenceMode;
    degradedPolicy?: OcxRoutingUnknownEvidenceMode;
    outcome: "satisfied" | "penalized" | "excluded" | "unknown";
    reason?: string;
  }>;
}

export const COMPATIBILITY_UNKNOWN_PENALTY_SCORE = 0.3;
export const MAX_TRACE_COMPATIBILITY_SUITES = 8;
