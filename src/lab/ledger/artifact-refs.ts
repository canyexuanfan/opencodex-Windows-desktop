import type { ClaimSnapshotEvent, LabEvent, ObservationEvent } from "../events/types";
import { isEventExcluded, type InvalidationIndex } from "./invalidation";

/** Collect every artifact digest referenced by non-excluded evidence events. */
export function collectReferencedArtifactDigests(
  events: LabEvent[],
  index: InvalidationIndex,
  opts: { excludeEventIds?: Set<string> } = {},
): Set<string> {
  const refs = new Set<string>();
  const exclude = opts.excludeEventIds ?? new Set<string>();

  for (const event of events) {
    if (exclude.has(event.eventId)) continue;
    if (isEventExcluded(event.eventId, index)) continue;

    if (event.eventKind === "observation") {
      addObservationArtifacts(event, refs);
      continue;
    }
    if (event.eventKind === "claim_snapshot") {
      refs.add(event.sourceManifestDigest);
    }
  }
  return refs;
}

function addObservationArtifacts(obs: ObservationEvent, refs: Set<string>): void {
  refs.add(obs.scenarioManifestDigest);
  refs.add(obs.suiteManifestDigest);
  for (const digest of obs.fixtureDigests) refs.add(digest);
  for (const ref of obs.artifactRefs) refs.add(ref.digest);
}

export function eventReferencesArtifactDigest(event: LabEvent, digest: string): boolean {
  if (event.eventKind === "observation") {
    if (event.scenarioManifestDigest === digest) return true;
    if (event.suiteManifestDigest === digest) return true;
    if (event.fixtureDigests.includes(digest)) return true;
    return event.artifactRefs.some((ref) => ref.digest === digest);
  }
  if (event.eventKind === "claim_snapshot") {
    return event.sourceManifestDigest === digest;
  }
  return false;
}

/**
 * Expand purge targets so explicitly sensitive artifact digests cannot survive
 * while still-referenced evidence remains.
 */
export function expandSensitiveArtifactEventTargets(
  events: LabEvent[],
  index: InvalidationIndex,
  targetEventIds: Set<string>,
  explicitArtifactDigests: Set<string>,
): Set<string> {
  const expanded = new Set(targetEventIds);
  if (explicitArtifactDigests.size === 0) return expanded;

  let changed = true;
  while (changed) {
    changed = false;
    for (const event of events) {
      if (expanded.has(event.eventId)) continue;
      if (isEventExcluded(event.eventId, index)) continue;
      for (const digest of explicitArtifactDigests) {
        if (eventReferencesArtifactDigest(event, digest)) {
          expanded.add(event.eventId);
          changed = true;
          break;
        }
      }
    }
  }
  return expanded;
}

/**
 * Artifact digests still required by surviving usable evidence after excluding
 * the given event IDs (e.g. purge targets).
 */
export function artifactsStillRequired(
  events: LabEvent[],
  index: InvalidationIndex,
  excludeEventIds: Set<string>,
): Set<string> {
  return collectReferencedArtifactDigests(events, index, { excludeEventIds });
}

/** Digests that may be deleted when purging the given event/artifact targets. */
export function deletableArtifactDigests(
  events: LabEvent[],
  index: InvalidationIndex,
  targetEventIds: Set<string>,
  explicitArtifactDigests: string[],
): string[] {
  const explicit = new Set(explicitArtifactDigests);
  const stillRequired = artifactsStillRequired(events, index, targetEventIds);
  const candidates = new Set<string>(explicitArtifactDigests);

  for (const event of events) {
    if (!targetEventIds.has(event.eventId)) continue;
    if (event.eventKind === "observation") {
      const scratch = new Set<string>();
      addObservationArtifacts(event, scratch);
      for (const digest of scratch) candidates.add(digest);
    } else if (event.eventKind === "claim_snapshot") {
      candidates.add(event.sourceManifestDigest);
    }
  }

  return [...candidates]
    .filter((digest) => explicit.has(digest) || !stillRequired.has(digest))
    .sort();
}

export function observationArtifactDigests(obs: ObservationEvent): string[] {
  const out = new Set<string>();
  addObservationArtifacts(obs, out);
  return [...out].sort();
}

export function claimArtifactDigests(claim: ClaimSnapshotEvent): string[] {
  return [claim.sourceManifestDigest];
}
