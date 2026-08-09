import { deleteArtifactBytes, openTrustedArtifactDir } from "../artifacts/secure-fs";
import { LAB_EVENT_SCHEMA_VERSION, LAB_PRODUCER, PURGE_ACTIONS } from "../constants";
import type { LabEvent, PurgeTombstoneEvent } from "../events/types";
import { assignEventId, validateLabEvent } from "../events/validate";
import { appendLabEvent, replayLabLedger } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import { rebuildLabProjection } from "../projection/rebuild";
import { jcsStringify } from "../digest";
import { readFileSync, writeFileSync } from "node:fs";

export interface SensitivePurgeRequest {
  configDir?: string;
  targetEventIds?: string[];
  targetArtifactDigests?: string[];
  purgeActions?: Array<(typeof PURGE_ACTIONS)[number]>;
  recordedAt?: number;
  producerVersion?: string;
}

/**
 * Exceptional sensitive-evidence purge:
 * append purge_tombstone, physically remove targeted JSONL lines and artifacts,
 * rebuild SQLite. Ordinary evidence is never rewritten by invalidation.
 */
export function purgeSensitiveEvidence(req: SensitivePurgeRequest): PurgeTombstoneEvent {
  const paths = ensureLabDirs(req.configDir);
  const targetEventIds = [...(req.targetEventIds ?? [])].sort();
  const targetArtifactDigests = [...(req.targetArtifactDigests ?? [])].sort();
  const purgeActions = [...(req.purgeActions ?? ["ledger", "sqlite", "artifact", "scratch"])].sort();

  const tombstone = validateLabEvent(
    assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "purge_tombstone" as const,
      recordedAt: req.recordedAt ?? Date.now(),
      producer: LAB_PRODUCER,
      producerVersion: req.producerVersion ?? "2.10.2",
      targetEventIds,
      targetArtifactDigests,
      reason: "sensitive_evidence" as const,
      purgeActions,
    }),
  ) as PurgeTombstoneEvent;

  // Capture current events before mutation.
  const replay = replayLabLedger(paths.ledgerPath);
  const removeIds = new Set(targetEventIds);

  appendLabEvent(paths.ledgerPath, tombstone);

  if (purgeActions.includes("ledger")) {
    const kept: LabEvent[] = [];
    for (const event of replay.events) {
      if (removeIds.has(event.eventId)) continue;
      kept.push(event);
    }
    kept.push(tombstone);
    const body = kept.map((e) => jcsStringify(e)).join("\n") + (kept.length ? "\n" : "");
    writeFileSync(paths.ledgerPath, body, { encoding: "utf8", mode: 0o600 });
  }

  if (purgeActions.includes("artifact")) {
    const dir = openTrustedArtifactDir(paths.artifactsDir);
    for (const digest of targetArtifactDigests) {
      try {
        deleteArtifactBytes(dir, digest);
      } catch {
        // already gone is acceptable for purge
      }
    }
    // Also drop artifacts exclusively owned by removed events when listed in their refs
    for (const event of replay.events) {
      if (!removeIds.has(event.eventId)) continue;
      if (event.eventKind === "observation") {
        for (const ref of event.artifactRefs) {
          try {
            deleteArtifactBytes(dir, ref.digest);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  if (purgeActions.includes("sqlite")) {
    rebuildLabProjection(req.configDir);
  }

  return tombstone;
}

/** Test helper: read raw ledger text. */
export function readLedgerText(configDir?: string): string {
  const paths = ensureLabDirs(configDir);
  return readFileSync(paths.ledgerPath, "utf8");
}
