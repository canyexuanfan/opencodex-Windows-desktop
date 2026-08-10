import type { OcxConfig, OcxProviderConfig } from "../../types";
import { candidateCapabilityEvidence } from "../capability";
import { costEvidenceForCandidate } from "../cost";
import type { PolicyCandidateEvidence } from "../evaluator";
import { policyCandidateHealthEvidence } from "../health";
import type { NormalizedRoutingProfile } from "../profile";
import { quotaEvidenceForCandidate } from "../quota";
import { loadCompatibilityEvidenceSnapshot } from "./reader";
import { resolvePolicyRouteSubject } from "./subject";
import type { CandidateCompatibilityEvidence } from "./types";

export type RoutedProviderResolver = (
  providerName: string,
  provider: OcxProviderConfig,
) => OcxProviderConfig;

export interface AssemblePolicyEvidenceOptions {
  configDir?: string;
  routedProviderConfig: RoutedProviderResolver;
}

function attachCompatibilityEvidence(
  config: OcxConfig,
  candidate: { provider: string; model: string },
  snapshot: ReturnType<typeof loadCompatibilityEvidenceSnapshot>,
  routedProviderConfig: RoutedProviderResolver,
  configDir?: string,
): CandidateCompatibilityEvidence {
  const provider = config.providers[candidate.provider];
  if (!provider) {
    return { subjectResolved: false, projectionAvailable: snapshot.projectionAvailable, suites: [] };
  }
  let routed: OcxProviderConfig;
  try {
    routed = routedProviderConfig(candidate.provider, provider);
  } catch {
    return { subjectResolved: false, projectionAvailable: snapshot.projectionAvailable, suites: [] };
  }
  const resolved = resolvePolicyRouteSubject(config, candidate.provider, candidate.model, routed, configDir);
  if (!resolved) {
    return { subjectResolved: false, projectionAvailable: snapshot.projectionAvailable, suites: [] };
  }
  return {
    subjectId: resolved.subjectId,
    subjectResolved: true,
    projectionAvailable: snapshot.projectionAvailable,
    suites: (snapshot.bySubject.get(resolved.subjectId) ?? []).map(row => ({
      suiteId: row.suiteId,
      evidenceLayer: row.evidenceLayer,
      verdict: row.verdict,
      asOf: row.asOf,
      fresh: true,
      notes: row.notes,
    })),
  };
}

/**
 * Assemble production policy candidate evidence including compatibility snapshots.
 * Uses one bounded SQLite read for all candidate subject IDs.
 */
export function assemblePolicyCandidateEvidence(
  config: OcxConfig,
  profile: NormalizedRoutingProfile,
  now: number,
  options: AssemblePolicyEvidenceOptions,
): PolicyCandidateEvidence[] {
  const subjectIds: string[] = [];
  const resolvedByCandidate = new Map<string, string>();

  for (const candidate of profile.candidates) {
    const provider = config.providers[candidate.provider];
    if (!provider) continue;
    try {
      const routed = options.routedProviderConfig(candidate.provider, provider);
      const resolved = resolvePolicyRouteSubject(
        config,
        candidate.provider,
        candidate.model,
        routed,
        options.configDir,
      );
      if (resolved) {
        subjectIds.push(resolved.subjectId);
        resolvedByCandidate.set(`${candidate.provider}/${candidate.model}`, resolved.subjectId);
      }
    } catch {
      // subject construction failure → unknown evidence path
    }
  }

  const snapshot = profile.compatibility
    ? loadCompatibilityEvidenceSnapshot(subjectIds, options.configDir)
    : {
      projectionAvailable: true,
      projectionIncompatible: false,
      bySubject: new Map(),
    };

  return profile.candidates.map(candidate => {
    const key = `${candidate.provider}/${candidate.model}`;
    const subjectId = resolvedByCandidate.get(key);
    const compatibility = profile.compatibility
      ? attachCompatibilityEvidence(config, candidate, snapshot, options.routedProviderConfig, options.configDir)
      : undefined;
    if (compatibility && subjectId) compatibility.subjectId = subjectId;

    return {
      provider: candidate.provider,
      model: candidate.model,
      capability: candidateCapabilityEvidence(config, candidate.provider, candidate.model),
      health: policyCandidateHealthEvidence(config, candidate, now),
      quota: quotaEvidenceForCandidate({
        provider: candidate.provider,
        model: candidate.model,
      }),
      cost: costEvidenceForCandidate({
        provider: candidate.provider,
        model: candidate.model,
        limitUsd: profile.limits.maxEstimatedCostUsd,
      }),
      ...(compatibility ? { compatibility } : {}),
    };
  });
}
