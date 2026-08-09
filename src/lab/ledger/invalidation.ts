import type {
  ClaimSnapshotEvent,
  InvalidationEvent,
  LabEvent,
  LedgerCorruption,
  ObservationEvent,
  PurgeTombstoneEvent,
} from "../events/types";
import { LabValidationError } from "../events/validate";

export interface InvalidationIndex {
  /** eventId -> invalidation eventIds that targeted it */
  invalidatedBy: Map<string, string[]>;
  purgedEventIds: Set<string>;
  purgedArtifactDigests: Set<string>;
  corruptions: LedgerCorruption[];
}

/**
 * Apply purge tombstones before ordinary invalidations.
 * Invalidation target lists are atomic: any bad target rejects the whole event.
 */
export function buildInvalidationIndex(events: LabEvent[]): InvalidationIndex {
  const purgedEventIds = new Set<string>();
  const purgedArtifactDigests = new Set<string>();
  const invalidatedBy = new Map<string, string[]>();
  const corruptions: LedgerCorruption[] = [];

  const validEvidenceIds = new Map<string, { kind: "observation" | "claim_snapshot"; index: number }>();

  // First pass: record evidence positions; apply purges as encountered.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.eventKind === "observation" || event.eventKind === "claim_snapshot") {
      validEvidenceIds.set(event.eventId, { kind: event.eventKind, index: i });
      continue;
    }
    if (event.eventKind === "purge_tombstone") {
      applyPurge(event, purgedEventIds, purgedArtifactDigests);
    }
  }

  // Second pass: validate and apply invalidations against earlier evidence.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.eventKind !== "invalidation") continue;
    try {
      validateInvalidationTargets(event, events, i, validEvidenceIds, purgedEventIds);
      for (const target of event.targetEventIds) {
        const list = invalidatedBy.get(target) ?? [];
        list.push(event.eventId);
        invalidatedBy.set(target, list);
      }
    } catch (err) {
      corruptions.push({
        kind: "invalid_reference",
        eventId: event.eventId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { invalidatedBy, purgedEventIds, purgedArtifactDigests, corruptions };
}

function applyPurge(
  event: PurgeTombstoneEvent,
  purgedEventIds: Set<string>,
  purgedArtifactDigests: Set<string>,
): void {
  for (const id of event.targetEventIds) purgedEventIds.add(id);
  for (const digest of event.targetArtifactDigests) purgedArtifactDigests.add(digest);
}

function validateInvalidationTargets(
  event: InvalidationEvent,
  all: LabEvent[],
  index: number,
  validEvidenceIds: Map<string, { kind: "observation" | "claim_snapshot"; index: number }>,
  purgedEventIds: Set<string>,
): void {
  for (const target of event.targetEventIds) {
    if (target === event.eventId) {
      throw new LabValidationError("self_target", "invalidation cannot target itself");
    }
    const meta = validEvidenceIds.get(target);
    if (!meta) {
      // Could be unknown, or an invalidation/purge id
      const earlier = all.slice(0, index).find((e) => e.eventId === target);
      if (!earlier) {
        throw new LabValidationError("unknown_target", `unknown target ${target}`);
      }
      if (earlier.eventKind === "invalidation" || earlier.eventKind === "purge_tombstone") {
        throw new LabValidationError("bad_target_kind", `cannot invalidate ${earlier.eventKind}`);
      }
      throw new LabValidationError("unknown_target", `unknown target ${target}`);
    }
    if (meta.index >= index) {
      throw new LabValidationError("future_target", `target ${target} is not earlier`);
    }
    // Purged targets: sensitive line may no longer exist — invalidation still must not
    // name purge/invalidation kinds; naming a purged observation/claim id is allowed
    // only if it appeared earlier as valid evidence before purge. We keep meta from
    // first pass so previously-seen evidence ids remain addressable.
    void purgedEventIds;
  }
}

export function isEventExcluded(
  eventId: string,
  index: InvalidationIndex,
): boolean {
  if (index.purgedEventIds.has(eventId)) return true;
  if (index.invalidatedBy.has(eventId)) return true;
  return false;
}

export function usableObservations(
  events: LabEvent[],
  index: InvalidationIndex,
): ObservationEvent[] {
  return events.filter(
    (e): e is ObservationEvent =>
      e.eventKind === "observation" && !isEventExcluded(e.eventId, index),
  );
}

export function usableClaims(
  events: LabEvent[],
  index: InvalidationIndex,
): ClaimSnapshotEvent[] {
  return events.filter(
    (e): e is ClaimSnapshotEvent =>
      e.eventKind === "claim_snapshot" && !isEventExcluded(e.eventId, index),
  );
}
