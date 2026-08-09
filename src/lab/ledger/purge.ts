import {
  closeTrustedArtifactDir,
  deleteArtifactBytes,
  openTrustedArtifactDir,
  type TrustedArtifactDir,
} from "../artifacts/secure-fs";
import { ArtifactFsError } from "../artifacts/secure-fs";
import { LAB_EVENT_SCHEMA_VERSION, LAB_PRODUCER, PURGE_ACTIONS } from "../constants";
import type { LabEvent, PurgeTombstoneEvent } from "../events/types";
import { assignEventId, validateLabEvent } from "../events/validate";
import {
  deletableArtifactDigests,
  expandSensitiveArtifactEventTargets,
} from "./artifact-refs";
import { buildInvalidationIndex } from "./invalidation";
import { appendLabEvent, replayLabLedger } from "./store";
import { ensureLabDirs } from "../paths";
import { rebuildLabProjection } from "../projection/rebuild";
import { jcsStringify } from "../digest";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export class PurgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PurgeError";
    this.code = code;
  }
}

export interface SensitivePurgeRequest {
  configDir?: string;
  targetEventIds?: string[];
  targetArtifactDigests?: string[];
  purgeActions?: Array<(typeof PURGE_ACTIONS)[number]>;
  recordedAt?: number;
  producerVersion?: string;
}

function atomicRewriteLedger(ledgerPath: string, events: LabEvent[]): void {
  const body = events.map((e) => jcsStringify(e)).join("\n") + (events.length ? "\n" : "");
  const bytes = new TextEncoder().encode(body);
  const tmpPath = join(join(ledgerPath, ".."), `.purge-${process.pid}-${Date.now()}.jsonl.tmp`);
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    const written = writeSync(fd, bytes);
    if (written !== bytes.byteLength) {
      throw new PurgeError("short_write", "ledger rewrite short write");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, ledgerPath);
  const ledgerFd = openSync(ledgerPath, "r+");
  try {
    fsyncSync(ledgerFd);
  } finally {
    closeSync(ledgerFd);
  }
}

function deleteArtifactsFailClosed(dir: TrustedArtifactDir, digests: string[]): void {
  const errors: string[] = [];
  for (const digest of digests) {
    try {
      deleteArtifactBytes(dir, digest);
    } catch (err) {
      if (err instanceof ArtifactFsError && err.message.includes("missing")) {
        continue;
      }
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new PurgeError("artifact_delete_failed", errors.join("; "));
  }
}

function purgeBoundedDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    try {
      rmSync(full, { recursive: entry.isDirectory(), force: true });
    } catch (err) {
      throw new PurgeError(
        "scratch_export_delete_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Exceptional sensitive-evidence purge:
 * physically remove targeted JSONL lines and artifacts, append purge_tombstone,
 * rebuild SQLite. Fails closed when required sensitive bytes cannot be removed.
 */
export function purgeSensitiveEvidence(req: SensitivePurgeRequest): PurgeTombstoneEvent {
  const paths = ensureLabDirs(req.configDir);
  const targetEventIds = [...(req.targetEventIds ?? [])].sort();
  const targetArtifactDigests = [...(req.targetArtifactDigests ?? [])].sort();
  const purgeActions = [...(req.purgeActions ?? ["ledger", "sqlite", "artifact", "scratch"])].sort();
  const explicitSensitive = new Set(targetArtifactDigests);

  const replay = replayLabLedger(paths.ledgerPath);
  const index = buildIndexFromReplay(replay.events);
  const removeIds = expandSensitiveArtifactEventTargets(
    replay.events,
    index,
    new Set(targetEventIds),
    explicitSensitive,
  );

  const tombstonePayload = {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "purge_tombstone" as const,
    recordedAt: req.recordedAt ?? Date.now(),
    producer: LAB_PRODUCER,
    producerVersion: req.producerVersion ?? "2.10.2",
    targetEventIds: [...removeIds].sort(),
    targetArtifactDigests,
    reason: "sensitive_evidence" as const,
    purgeActions,
  };
  const tombstone = validateLabEvent(assignEventId(tombstonePayload)) as PurgeTombstoneEvent;

  const deletable = purgeActions.includes("artifact")
    ? deletableArtifactDigests(replay.events, index, removeIds, targetArtifactDigests)
    : [];

  if (purgeActions.includes("artifact") && explicitSensitive.size > 0) {
    for (const digest of explicitSensitive) {
      if (!deletable.includes(digest)) {
        throw new PurgeError(
          "sensitive_artifact_not_deletable",
          `explicit sensitive artifact ${digest} could not be removed`,
        );
      }
    }
  }

  let dir: TrustedArtifactDir | null = null;
  try {
    if (purgeActions.includes("scratch")) {
      purgeBoundedDirectory(paths.scratchDir);
    }
    if (purgeActions.includes("export")) {
      purgeBoundedDirectory(paths.exportDir);
    }

    if (purgeActions.includes("artifact") && deletable.length > 0) {
      dir = openTrustedArtifactDir(paths.artifactsDir);
      deleteArtifactsFailClosed(dir, deletable);
    }

    if (purgeActions.includes("ledger")) {
      const kept: LabEvent[] = [];
      for (const event of replay.events) {
        if (removeIds.has(event.eventId)) continue;
        kept.push(event);
      }
      kept.push(tombstone);
      atomicRewriteLedger(paths.ledgerPath, kept);
    } else {
      appendLabEvent(paths.ledgerPath, tombstone);
    }

    if (purgeActions.includes("sqlite")) {
      rebuildLabProjection(req.configDir);
    }

    return tombstone;
  } catch (err) {
    throw err instanceof PurgeError ? err : new PurgeError("purge_failed", err instanceof Error ? err.message : String(err));
  } finally {
    if (dir) closeTrustedArtifactDir(dir);
  }
}

function buildIndexFromReplay(events: LabEvent[]) {
  return buildInvalidationIndex(events);
}

/** Test helper: read raw ledger text. */
export function readLedgerText(configDir?: string): string {
  const paths = ensureLabDirs(configDir);
  return readFileSync(paths.ledgerPath, "utf8");
}
