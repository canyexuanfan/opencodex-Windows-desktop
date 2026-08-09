import type { CompatibilityVerdict } from "../constants";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
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
}

/**
 * Resolve current claims after purge/invalidation and supersession.
 * Multiple unsuperseded claims, missing predecessors, cross-key supersession, or cycles → UNKNOWN + corruption.
 */
export function resolveClaimStates(claims: ClaimSnapshotEvent[]): {
  states: Map<string, ClaimState>;
  corruptions: LedgerCorruption[];
} {
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
    states.set(key, { key, current: current[0] ?? null });
  }

  return { states, corruptions };
}

/**
 * CL-02 verdict projection primitives.
 *
 * Full live-route/task coverage algorithms belong to later phases. This implements
 * the reusable precedence/freshness/invalidation semantics for protocol_conformance
 * observations and claim snapshots needed for persistence tests.
 */
export function projectVerdicts(
  events: LabEvent[],
  opts: { asOf?: number; index?: InvalidationIndex } = {},
): { verdicts: DerivedVerdict[]; corruptions: LedgerCorruption[]; index: InvalidationIndex } {
  const index = opts.index ?? buildInvalidationIndex(events);
  const corruptions = [...index.corruptions];
  const asOf =
    opts.asOf ??
    events.reduce((max, event) => {
      if (event.eventKind === "observation") return Math.max(max, event.completedAt, event.recordedAt);
      if (event.eventKind === "claim_snapshot") return Math.max(max, event.effectiveAt, event.recordedAt);
      return Math.max(max, event.recordedAt);
    }, 0);

  const observations = usableObservations(events, index).filter((o) => o.completedAt <= asOf);
  const claims = usableClaims(events, index).filter((c) => c.effectiveAt <= asOf);
  const { states: claimStates, corruptions: claimCorruptions } = resolveClaimStates(claims);
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
    verdicts.push(projectObservationGroup(key, ordered, asOf));
  }

  // Claim-only keys (live_route_compatibility) when no executable observations exist.
  for (const [, state] of claimStates) {
    if (!state.current || state.current.polarity !== "supported") continue;
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
    // Claims cannot produce PROBED/VERIFIED.
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
): DerivedVerdict {
  const contributing: string[] = [];
  const contradicting: string[] = [];
  const digests = new Set<string>();
  const notes: string[] = [];

  // Conservative protocol projection for CL-02:
  // - all required-role passes for covered scenarios → VERIFIED when every obs passes
  // - mix of pass/fail → DEGRADED (newer required failure prevents VERIFIED)
  // - only passes but incomplete suite metadata → PROBED
  // - blocked → BLOCKED if no conclusive result
  // Protocol claims are forbidden — never CLAIMED here.

  let sawPass = false;
  let sawFail = false;
  let sawBlocked = false;
  let sawInconclusive = false;

  for (const obs of ordered) {
    digests.add(obs.scenarioManifestDigest);
    contributing.push(obs.eventId);
    if (obs.outcome === "pass") sawPass = true;
    else if (obs.outcome === "fail") {
      sawFail = true;
      contradicting.push(obs.eventId);
    } else if (obs.outcome === "blocked") sawBlocked = true;
    else if (obs.outcome === "inconclusive") sawInconclusive = true;
    else {
      const _never: never = obs.outcome;
      void _never;
    }
  }

  let verdict: CompatibilityVerdict = "UNKNOWN";
  if (key.evidenceLayer !== "protocol_conformance" && key.evidenceLayer !== "live_route_compatibility" && key.evidenceLayer !== "task_effectiveness") {
    verdict = "UNKNOWN";
  } else if (sawFail && sawPass) {
    // Newer failure prevents VERIFIED; remain DEGRADED until repair coverage.
    verdict = "DEGRADED";
    notes.push("contradiction_conservative_v1");
  } else if (sawFail) {
    const last = ordered[ordered.length - 1]!;
    if (last.failure?.class === "capability_failure" && last.expectedFailure) {
      verdict = "UNSUPPORTED";
      notes.push("capability_absence_control");
    } else {
      verdict = "DEGRADED";
    }
  } else if (sawPass && !sawInconclusive && !sawBlocked) {
    // Full verification rule evaluation is suite-manifest driven in later phases.
    // CL-02 treats an all-pass observation set for this projection key as VERIFIED
    // only when every observation is protocol_conformance fixture mode; otherwise PROBED.
    const allFixtureProtocol = ordered.every(
      (o) => o.evidenceLayer === "protocol_conformance" && o.executionMode === "fixture",
    );
    verdict = allFixtureProtocol ? "VERIFIED" : "PROBED";
  } else if (sawPass) {
    verdict = "PROBED";
  } else if (sawBlocked) {
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
