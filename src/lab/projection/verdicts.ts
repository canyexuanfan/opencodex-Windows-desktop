import type { CompatibilityVerdict } from "../constants";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
import type {
  ClaimSnapshotEvent,
  LabEvent,
  LedgerCorruption,
  ObservationEvent,
} from "../events/types";
import {
  buildInvalidationIndex,
  isEventExcluded,
  usableClaims,
  usableObservations,
  type InvalidationIndex,
} from "../ledger/invalidation";
import { evaluateAllApplicableRequiredPassV1, newestObservationByScenario } from "./verification";

export interface ProjectionKey {
  subjectId: string;
  evidenceLayer: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  projectionSpecVersion: string;
}

export function projectionKeyString(key: ProjectionKey): string {
  return [
    key.subjectId,
    key.evidenceLayer,
    key.suiteId,
    key.suiteVersion,
    key.suiteManifestDigest,
    key.projectionSpecVersion,
  ].join("|");
}

export interface DerivedVerdict {
  key: ProjectionKey;
  verdict: CompatibilityVerdict;
  asOf: number;
  scenarioManifestDigests: string[];
  claimSourceDigest?: string;
  contributingEventIds: string[];
  contradictingEventIds: string[];
  notes: string[];
}

export interface ClaimState {
  key: string;
  current: ClaimSnapshotEvent | null;
  corruption?: string;
  unusable?: boolean;
}

export interface ProjectVerdictsOptions {
  asOf?: number;
  index?: InvalidationIndex;
  unusableObservationIds?: Set<string>;
  unusableClaimEventIds?: Set<string>;
  loadSuiteManifest?: (digest: string) => SuiteManifestV1 | null;
  loadScenarioManifest?: (digest: string) => Record<string, unknown> | null;
  loadScenarioRequirements?: (digest: string) => {
    inboundProtocols?: string[];
    upstreamProtocols?: string[];
    surfaces?: string[];
  } | null;
}

/**
 * Resolve current claims after purge/invalidation and supersession.
 * Multiple unsuperseded claims, missing predecessors, cross-key supersession, or cycles → UNKNOWN + corruption.
 */
export function resolveClaimStates(
  claims: ClaimSnapshotEvent[],
  opts: { unusableClaimEventIds?: Set<string> } = {},
): {
  states: Map<string, ClaimState>;
  corruptions: LedgerCorruption[];
} {
  const unusableClaims = opts.unusableClaimEventIds ?? new Set<string>();
  const byKey = new Map<string, ClaimSnapshotEvent[]>();
  for (const claim of claims) {
    const key = `${claim.subjectId}|${claim.capability}`;
    const list = byKey.get(key) ?? [];
    list.push(claim);
    byKey.set(key, list);
  }

  const states = new Map<string, ClaimState>();
  const corruptions: LedgerCorruption[] = [];

  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => {
      if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt;
      if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });

    const superseded = new Set<string>();
    const byId = new Map(sorted.map((c) => [c.eventId, c]));

    for (const claim of sorted) {
      for (const pred of claim.supersedes) {
        const prev = byId.get(pred);
        if (!prev) {
          corruptions.push({
            kind: "claim_corruption",
            eventId: claim.eventId,
            detail: `missing supersedes predecessor ${pred}`,
          });
          states.set(key, { key, current: null, corruption: "missing predecessor" });
          continue;
        }
        if (prev.subjectId !== claim.subjectId || prev.capability !== claim.capability) {
          corruptions.push({
            kind: "claim_corruption",
            eventId: claim.eventId,
            detail: "cross-key supersession",
          });
          states.set(key, { key, current: null, corruption: "cross-key supersession" });
          continue;
        }
        superseded.add(pred);
      }
    }

    if (states.get(key)?.corruption) continue;

    const current = sorted.filter((c) => !superseded.has(c.eventId));
    if (current.length > 1) {
      corruptions.push({
        kind: "claim_corruption",
        detail: `multiple unsuperseded claims for ${key}`,
      });
      states.set(key, { key, current: null, corruption: "conflicting current claims" });
      continue;
    }
    const currentClaim = current[0] ?? null;
    states.set(key, {
      key,
      current: currentClaim,
      unusable: currentClaim ? unusableClaims.has(currentClaim.eventId) : undefined,
    });
  }

  return { states, corruptions };
}

/**
 * CL-02 verdict projection primitives with frozen CL-00 verification semantics.
 */
export function projectVerdicts(
  events: LabEvent[],
  opts: ProjectVerdictsOptions = {},
): { verdicts: DerivedVerdict[]; corruptions: LedgerCorruption[]; index: InvalidationIndex } {
  const index = opts.index ?? buildInvalidationIndex(events);
  const corruptions = [...index.corruptions];
  const unusableObs = opts.unusableObservationIds ?? new Set<string>();
  const unusableClaims = opts.unusableClaimEventIds ?? new Set<string>();
  const asOf =
    opts.asOf ??
    events.reduce((max, event) => {
      if (event.eventKind === "observation") return Math.max(max, event.completedAt, event.recordedAt);
      if (event.eventKind === "claim_snapshot") return Math.max(max, event.effectiveAt, event.recordedAt);
      return Math.max(max, event.recordedAt);
    }, 0);

  const observations = usableObservations(events, index)
    .filter((o) => o.completedAt <= asOf)
    .filter((o) => !unusableObs.has(o.eventId));
  const claims = usableClaims(events, index).filter((c) => c.effectiveAt <= asOf);
  const { states: claimStates, corruptions: claimCorruptions } = resolveClaimStates(claims, {
    unusableClaimEventIds: unusableClaims,
  });
  corruptions.push(...claimCorruptions);

  const groups = new Map<string, ObservationEvent[]>();
  for (const obs of observations) {
    const key: ProjectionKey = {
      subjectId: obs.subjectId,
      evidenceLayer: obs.evidenceLayer,
      suiteId: obs.suiteId,
      suiteVersion: obs.suiteVersion,
      suiteManifestDigest: obs.suiteManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ks = projectionKeyString(key);
    const list = groups.get(ks) ?? [];
    list.push(obs);
    groups.set(ks, list);
  }

  const verdicts: DerivedVerdict[] = [];

  for (const [, list] of groups) {
    const sample = list[0]!;
    const key: ProjectionKey = {
      subjectId: sample.subjectId,
      evidenceLayer: sample.evidenceLayer,
      suiteId: sample.suiteId,
      suiteVersion: sample.suiteVersion,
      suiteManifestDigest: sample.suiteManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ordered = [...list].sort((a, b) => {
      if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    const suiteManifest = opts.loadSuiteManifest?.(key.suiteManifestDigest) ?? null;
    verdicts.push(
      projectObservationGroup(key, ordered, asOf, suiteManifest, {
        loadScenarioManifest: opts.loadScenarioManifest,
        loadScenarioRequirements: opts.loadScenarioRequirements,
      }),
    );
  }

  for (const [, state] of claimStates) {
    if (!state.current || state.current.polarity !== "supported") continue;
    if (state.corruption) continue;
    const claim = state.current;
    const key: ProjectionKey = {
      subjectId: claim.subjectId,
      evidenceLayer: "live_route_compatibility",
      suiteId: "_claims",
      suiteVersion: "1",
      suiteManifestDigest: claim.sourceManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ks = projectionKeyString(key);
    if (verdicts.some((v) => projectionKeyString(v.key) === ks)) continue;
    if (state.unusable) {
      verdicts.push({
        key,
        verdict: "UNKNOWN",
        asOf,
        scenarioManifestDigests: [],
        claimSourceDigest: claim.sourceManifestDigest,
        contributingEventIds: [claim.eventId],
        contradictingEventIds: [],
        notes: ["current_claim_unusable"],
      });
      continue;
    }
    verdicts.push({
      key,
      verdict: "CLAIMED",
      asOf,
      scenarioManifestDigests: [],
      claimSourceDigest: claim.sourceManifestDigest,
      contributingEventIds: [claim.eventId],
      contradictingEventIds: [],
      notes: ["claim_snapshot"],
    });
  }

  return { verdicts, corruptions, index };
}

function projectObservationGroup(
  key: ProjectionKey,
  ordered: ObservationEvent[],
  asOf: number,
  suiteManifest: SuiteManifestV1 | null,
  opts: { loadScenarioManifest?: (digest: string) => Record<string, unknown> | null; loadScenarioRequirements?: ProjectVerdictsOptions["loadScenarioRequirements"] } = {},
): DerivedVerdict {
  const contributing: string[] = [];
  const contradicting: string[] = [];
  const digests = new Set<string>();
  const notes: string[] = [];

  for (const obs of ordered) {
    digests.add(obs.scenarioManifestDigest);
    contributing.push(obs.eventId);
    if (obs.outcome === "fail") contradicting.push(obs.eventId);
  }

  const newest = newestObservationByScenario(ordered);
  const currentObservations = [...newest.values()];
  const currentFails = currentObservations.filter((o) => o.outcome === "fail");
  const currentPasses = currentObservations.filter((o) => o.outcome === "pass");
  const currentBlocked = currentObservations.some((o) => o.outcome === "blocked");
  const currentInconclusive = currentObservations.some((o) => o.outcome === "inconclusive");

  let verdict: CompatibilityVerdict = "UNKNOWN";
  if (
    key.evidenceLayer !== "protocol_conformance" &&
    key.evidenceLayer !== "live_route_compatibility" &&
    key.evidenceLayer !== "task_effectiveness"
  ) {
    verdict = "UNKNOWN";
  } else if (currentFails.length > 0) {
    const lastFail = currentFails.sort((a, b) => {
      if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    })[currentFails.length - 1]!;
    if (lastFail.failure?.class === "capability_failure" && lastFail.expectedFailure) {
      verdict = "UNSUPPORTED";
      notes.push("capability_absence_control");
    } else {
      verdict = "DEGRADED";
    }
  } else if (currentPasses.length > 0 && !currentInconclusive && !currentBlocked) {
    const executionMode = ordered[0]!.executionMode;
    const subject = ordered[0]!.subject;
    if (key.evidenceLayer === "protocol_conformance" && executionMode === "fixture") {
      if (!suiteManifest) {
        verdict = "PROBED";
        notes.push("suite_manifest_unavailable");
      } else {
        const evaluation = evaluateAllApplicableRequiredPassV1(
          suiteManifest,
          ordered,
          executionMode,
          {
            subject: subject.subjectKind === "protocol" ? subject : undefined,
            loadScenarioManifest: opts.loadScenarioManifest,
            loadScenarioRequirements: opts.loadScenarioRequirements,
          },
        );
        notes.push(...evaluation.notes);
        if (evaluation.applicableRequiredScenarioIds.length === 0) {
          verdict = "UNKNOWN";
        } else if (evaluation.canVerify) {
          verdict = "VERIFIED";
          notes.push("all-applicable-required-pass-v1");
        } else {
          verdict = "PROBED";
          notes.push("incomplete_required_coverage");
        }
      }
    } else {
      verdict = "PROBED";
    }
  } else if (currentPasses.length > 0) {
    verdict = "PROBED";
  } else if (currentBlocked) {
    verdict = "BLOCKED";
  } else {
    verdict = "UNKNOWN";
  }

  return {
    key,
    verdict,
    asOf,
    scenarioManifestDigests: [...digests].sort(),
    contributingEventIds: contributing,
    contradictingEventIds: contradicting,
    notes,
  };
}

export function excludeEventIds(index: InvalidationIndex): Set<string> {
  const out = new Set<string>([...index.purgedEventIds]);
  for (const id of index.invalidatedBy.keys()) out.add(id);
  return out;
}

export { isEventExcluded };
