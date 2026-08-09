import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { createArtifactStore } from "../artifacts/store";
import { ArtifactFsError } from "../artifacts/secure-fs";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import { expandScenario, loadCaseAuthority } from "../conformance/manifest";
import { scenarioManifestDigest, jcsStringify } from "../digest";
import { parseSuiteManifestFromArtifact } from "./verification";
import type { ClaimSnapshotEvent, LabEvent, LedgerCorruption } from "../events/types";
import { loadClaimSourceManifest } from "../artifacts/store";
import { buildInvalidationIndex, isEventExcluded } from "../ledger/invalidation";
import { replayLabLedger } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import { LAB_SQLITE_DDL, LAB_SQLITE_SCHEMA_VERSION } from "./schema";
import {
  excludeEventIds,
  projectVerdicts,
  projectionKeyString,
  resolveClaimStates,
} from "./verdicts";

export interface RebuildResult {
  events: number;
  verdicts: number;
  corruptions: LedgerCorruption[];
  sqlitePath: string;
}

function wipeSqlite(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        if (existsSync(candidate)) unlinkSync(candidate);
        break;
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        if (code !== "EBUSY" && code !== "EPERM") throw err;
        Bun.sleepSync(20 * (attempt + 1));
      }
    }
  }
}

function resetProjectionSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec(`
    DROP TABLE IF EXISTS verdicts;
    DROP TABLE IF EXISTS corruption;
    DROP TABLE IF EXISTS artifacts;
    DROP TABLE IF EXISTS purges;
    DROP TABLE IF EXISTS invalidations;
    DROP TABLE IF EXISTS claims;
    DROP TABLE IF EXISTS observations;
    DROP TABLE IF EXISTS subjects;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS schema_meta;
  `);
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(LAB_SQLITE_DDL);
}

interface ArtifactValidationResult {
  unusableObservationIds: Set<string>;
  unusableClaimEventIds: Set<string>;
}

/**
 * Deterministic rebuild:
 * delete compatibility.sqlite → replay JSONL → validate artifacts → project.
 */
export function rebuildLabProjection(configDir?: string): RebuildResult {
  const paths = ensureLabDirs(configDir);
  wipeSqlite(paths.sqlitePath);

  const replay = replayLabLedger(paths.ledgerPath);
  const corruptions: LedgerCorruption[] = [...replay.corruptions];
  const index = buildInvalidationIndex(replay.events);
  corruptions.push(...index.corruptions);

  const artifactStore = createArtifactStore(paths.artifactsDir);
  const validation = validateRequiredArtifacts(replay.events, index, artifactStore, corruptions);

  const authority = loadCaseAuthority();
  const scenarioRequirementsByDigest = new Map<string, {
    inboundProtocols?: string[];
    upstreamProtocols?: string[];
    surfaces?: string[];
  }>();
  for (const caseRecord of authority.cases) {
    const expanded = expandScenario(caseRecord, authority);
    scenarioRequirementsByDigest.set(scenarioManifestDigest(expanded), caseRecord.requirements);
  }

  const loadSuiteManifest = (digest: string) => {
    try {
      const bytes = artifactStore.get(digest);
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parseSuiteManifestFromArtifact(parsed);
    } catch {
      return null;
    }
  };
  const loadScenarioManifest = (digest: string) => {
    try {
      const bytes = artifactStore.get(digest);
      return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const loadScenarioRequirements = (digest: string) => scenarioRequirementsByDigest.get(digest) ?? null;

  const db = new Database(paths.sqlitePath);
  try {
    db.exec("PRAGMA journal_mode=DELETE;");
    resetProjectionSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)",
    ).run("schema_version", String(LAB_SQLITE_SCHEMA_VERSION));
    db.prepare(
      "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)",
    ).run("projection_spec_version", LAB_PROJECTION_SPEC_VERSION);
    db.prepare(
      "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)",
    ).run("built_at_ms", String(Date.now()));

    const insertCorruption = db.prepare(
      "INSERT INTO corruption(kind, line_number, event_id, detail) VALUES (?, ?, ?, ?)",
    );
    for (const c of corruptions) {
      insertCorruption.run(c.kind, c.lineNumber ?? null, c.eventId ?? null, c.detail);
    }

    const insertEvent = db.prepare(
      `INSERT INTO events(event_id, event_kind, recorded_at, producer, producer_version, payload_json, excluded, exclusion_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSubject = db.prepare(
      `INSERT OR IGNORE INTO subjects(subject_id, subject_kind, subject_json) VALUES (?, ?, ?)`,
    );
    const insertObs = db.prepare(
      `INSERT INTO observations(
         event_id, subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest,
         scenario_id, scenario_version, scenario_manifest_digest, outcome, completed_at, execution_mode
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertClaim = db.prepare(
      `INSERT INTO claims(
         event_id, subject_id, capability, polarity, source_manifest_digest,
         effective_at, recorded_at, supersedes_json, current, usable
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertInv = db.prepare(
      `INSERT INTO invalidations(event_id, reason, targets_json, recorded_at, applied) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertPurge = db.prepare(
      `INSERT INTO purges(event_id, target_event_ids_json, target_artifact_digests_json, purge_actions_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertArtifact = db.prepare(
      `INSERT OR REPLACE INTO artifacts(digest, artifact_class, media_type, byte_count, status, last_error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const excluded = excludeEventIds(index);
    const usableClaimEvents = replay.events.filter(
      (e): e is ClaimSnapshotEvent =>
        e.eventKind === "claim_snapshot" && !isEventExcluded(e.eventId, index),
    );

    for (const claim of usableClaimEvents) {
      const loaded = loadClaimSourceManifest(artifactStore, claim.sourceManifestDigest, {
        subjectId: claim.subjectId,
        capability: claim.capability,
      });
      if (loaded.corruption) {
        validation.unusableClaimEventIds.add(claim.eventId);
      }
    }

    const claimStates = resolveClaimStates(usableClaimEvents, {
      unusableClaimEventIds: validation.unusableClaimEventIds,
    });

    for (const event of replay.events) {
      const isExcluded = excluded.has(event.eventId);
      let exclusionReason: string | null = null;
      if (index.purgedEventIds.has(event.eventId)) exclusionReason = "purged";
      else if (index.invalidatedBy.has(event.eventId)) exclusionReason = "invalidated";

      insertEvent.run(
        event.eventId,
        event.eventKind,
        event.recordedAt,
        event.producer,
        event.producerVersion,
        jcsStringify(event),
        isExcluded ? 1 : 0,
        exclusionReason,
      );

      if (event.eventKind === "observation") {
        insertSubject.run(event.subjectId, event.subject.subjectKind, jcsStringify(event.subject));
        const usable = !isExcluded && !validation.unusableObservationIds.has(event.eventId);
        if (usable) {
          insertObs.run(
            event.eventId,
            event.subjectId,
            event.evidenceLayer,
            event.suiteId,
            event.suiteVersion,
            event.suiteManifestDigest,
            event.scenarioId,
            event.scenarioVersion,
            event.scenarioManifestDigest,
            event.outcome,
            event.completedAt,
            event.executionMode,
          );
        }
        for (const ref of event.artifactRefs) {
          const purged = index.purgedArtifactDigests.has(ref.digest);
          const corrupt = validation.unusableObservationIds.has(event.eventId);
          insertArtifact.run(
            ref.digest,
            ref.artifactClass,
            ref.mediaType,
            ref.byteCount,
            purged ? "purged_unavailable" : corrupt ? "corrupt" : "present",
            corrupt ? "required artifact unusable" : null,
          );
        }
      } else if (event.eventKind === "claim_snapshot") {
        insertSubject.run(event.subjectId, event.subject.subjectKind, jcsStringify(event.subject));
        const key = `${event.subjectId}|${event.capability}`;
        const state = claimStates.states.get(key);
        const current = state?.current?.eventId === event.eventId ? 1 : 0;
        let usable = !isExcluded && !state?.corruption && !validation.unusableClaimEventIds.has(event.eventId) ? 1 : 0;

        if (!isExcluded) {
          const loaded = loadClaimSourceManifest(artifactStore, event.sourceManifestDigest, {
            subjectId: event.subjectId,
            capability: event.capability,
          });
          if (loaded.corruption) {
            usable = 0;
            corruptions.push({
              kind: "claim_corruption",
              eventId: event.eventId,
              detail: loaded.corruption,
            });
            insertCorruption.run("claim_corruption", null, event.eventId, loaded.corruption);
            insertArtifact.run(
              event.sourceManifestDigest,
              "claim_source_manifest",
              "application/json",
              null,
              "corrupt",
              loaded.corruption,
            );
          } else {
            insertArtifact.run(
              event.sourceManifestDigest,
              "claim_source_manifest",
              "application/json",
              null,
              "present",
              null,
            );
          }
        }

        insertClaim.run(
          event.eventId,
          event.subjectId,
          event.capability,
          event.polarity,
          event.sourceManifestDigest,
          event.effectiveAt,
          event.recordedAt,
          jcsStringify(event.supersedes),
          current,
          usable,
        );
      } else if (event.eventKind === "invalidation") {
        const applied = !corruptions.some((c) => c.eventId === event.eventId && c.kind === "invalid_reference");
        insertInv.run(
          event.eventId,
          event.reason,
          jcsStringify(event.targetEventIds),
          event.recordedAt,
          applied ? 1 : 0,
        );
      } else if (event.eventKind === "purge_tombstone") {
        insertPurge.run(
          event.eventId,
          jcsStringify(event.targetEventIds),
          jcsStringify(event.targetArtifactDigests),
          jcsStringify(event.purgeActions),
          event.recordedAt,
        );
        for (const digest of event.targetArtifactDigests) {
          insertArtifact.run(digest, null, null, null, "purged_unavailable", null);
        }
      }
    }

    const { verdicts, corruptions: verdictCorruptions } = projectVerdicts(replay.events, {
      index,
      unusableObservationIds: validation.unusableObservationIds,
      unusableClaimEventIds: validation.unusableClaimEventIds,
      loadSuiteManifest,
      loadScenarioManifest,
      loadScenarioRequirements,
    });
    for (const c of verdictCorruptions) {
      if (!corruptions.some((x) => x.detail === c.detail && x.eventId === c.eventId)) {
        corruptions.push(c);
        insertCorruption.run(c.kind, c.lineNumber ?? null, c.eventId ?? null, c.detail);
      }
    }

    const insertVerdict = db.prepare(
      `INSERT INTO verdicts(
         projection_key, subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest,
         projection_spec_version, verdict, as_of, scenario_manifest_digests_json, claim_source_digest,
         contributing_event_ids_json, contradicting_event_ids_json, notes_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const v of verdicts) {
      if (v.contributingEventIds.every((id) => index.purgedEventIds.has(id))) continue;
      if (v.contributingEventIds.some((id) => index.purgedEventIds.has(id) || index.invalidatedBy.has(id))) {
        const remaining = v.contributingEventIds.filter(
          (id) => !index.purgedEventIds.has(id) && !index.invalidatedBy.has(id),
        );
        if (remaining.length === 0) continue;
      }
      insertVerdict.run(
        projectionKeyString(v.key),
        v.key.subjectId,
        v.key.evidenceLayer,
        v.key.suiteId,
        v.key.suiteVersion,
        v.key.suiteManifestDigest,
        v.key.projectionSpecVersion,
        v.verdict,
        v.asOf,
        jcsStringify(v.scenarioManifestDigests),
        v.claimSourceDigest ?? null,
        jcsStringify(v.contributingEventIds),
        jcsStringify(v.contradictingEventIds),
        jcsStringify(v.notes),
      );
    }

    return {
      events: replay.events.length,
      verdicts: verdicts.length,
      corruptions,
      sqlitePath: paths.sqlitePath,
    };
  } finally {
    db.close();
    artifactStore.close();
  }
}

function validateRequiredArtifacts(
  events: LabEvent[],
  index: ReturnType<typeof buildInvalidationIndex>,
  artifactStore: ReturnType<typeof createArtifactStore>,
  corruptions: LedgerCorruption[],
): ArtifactValidationResult {
  const unusableObservationIds = new Set<string>();
  const unusableClaimEventIds = new Set<string>();

  for (const event of events) {
    if (isEventExcluded(event.eventId, index)) continue;
    if (event.eventKind === "observation") {
      const required = [
        event.scenarioManifestDigest,
        event.suiteManifestDigest,
        ...event.fixtureDigests,
      ];
      let unusable = false;
      for (const digest of required) {
        if (index.purgedArtifactDigests.has(digest)) {
          corruptions.push({
            kind: "missing_artifact",
            eventId: event.eventId,
            detail: `required artifact purged: ${digest}`,
          });
          unusable = true;
          continue;
        }
        try {
          artifactStore.get(digest);
        } catch (err) {
          corruptions.push({
            kind: err instanceof ArtifactFsError && err.message.includes("mismatch")
              ? "artifact_mismatch"
              : "missing_artifact",
            eventId: event.eventId,
            detail: err instanceof Error ? err.message : String(err),
          });
          unusable = true;
        }
      }
      if (unusable) unusableObservationIds.add(event.eventId);
    }
  }

  return { unusableObservationIds, unusableClaimEventIds };
}

/** Snapshot derived verdict rows for rebuild-determinism tests (excludes asOf wall clock). */
export function readVerdictSnapshot(sqlitePath: string): unknown[] {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT projection_key, subject_id, evidence_layer, suite_id, suite_version,
                suite_manifest_digest, projection_spec_version, verdict,
                scenario_manifest_digests_json, claim_source_digest,
                contributing_event_ids_json, contradicting_event_ids_json, notes_json
         FROM verdicts ORDER BY projection_key`,
      )
      .all();
    return rows;
  } finally {
    db.close();
  }
}

export function readCorruptionRows(sqlitePath: string): unknown[] {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return db.query(`SELECT kind, line_number, event_id, detail FROM corruption ORDER BY id`).all();
  } finally {
    db.close();
  }
}
