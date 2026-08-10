import { existsSync } from "node:fs";
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import { sanitizeDiagnostic, truncateUtf8 } from "../artifacts/sanitize";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PRODUCER_VERSION,
  OBSERVATION_LIMIT_NAMES,
} from "../constants";
import { fixtureDigest } from "../digest";
import type { ObservationEvent } from "../events/types";
import { assignEventId } from "../events/validate";
import { appendLabEvent, replayLabLedger } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import {
  FABRIC_EVIDENCE_LAYER,
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
} from "./constants";
import {
  expandFabricScenario,
  expandFabricSuiteManifest,
  fabricScenarioManifestDigest,
  fabricSuiteManifestDigest,
  loadFabricCaseAuthority,
} from "./manifest";
import type { FabricTaskOutcomeV1 } from "./types";
import { FabricTaskError } from "./types";

export interface PersistFabricOptions {
  configDir?: string;
  recordedAt?: number;
  producerVersion?: string;
  artifactStore?: ArtifactStore;
  attempt?: number;
}

export interface PersistedFabricObservation {
  event: ObservationEvent;
  ledgerPath: string;
}

const OUTCOME_KEYS = new Set([
  "schemaVersion",
  "taskClassId",
  "taskClassVersion",
  "routeSubject",
  "taskSubject",
  "subjectId",
  "taskFixtureDigest",
  "verifierManifestDigest",
  "fabricCompatibilityVersion",
  "sandboxProfileDigest",
  "startedAt",
  "completedAt",
  "limits",
  "usage",
  "outcome",
  "verifier",
  "failure",
  "artifactDigests",
  "sourceRefs",
]);

export function assertFabricOutcomeV1(raw: unknown): FabricTaskOutcomeV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FabricTaskError("malformed producer outcome", "malformed_producer_outcome", "harness");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!OUTCOME_KEYS.has(key)) {
      throw new FabricTaskError(`unknown outcome field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  if (obj.schemaVersion !== 1) {
    throw new FabricTaskError("schemaVersion must be 1", "malformed_producer_outcome", "harness");
  }
  if (obj.taskSubject && typeof obj.taskSubject === "object" && !Array.isArray(obj.taskSubject)) {
    const kind = (obj.taskSubject as { subjectKind?: unknown }).subjectKind;
    if (kind !== "task") {
      throw new FabricTaskError("task layer rejects non-task subjects", "layer_subject_mismatch", "harness");
    }
  }
  return raw as FabricTaskOutcomeV1;
}

export function observationFromFabricOutcome(
  outcomeRaw: unknown,
  opts: PersistFabricOptions = {},
): { event: ObservationEvent; artifacts: ReturnType<ArtifactStore["put"]>[] } {
  const outcome = assertFabricOutcomeV1(outcomeRaw);
  if (outcome.taskSubject.subjectKind !== "task") {
    throw new FabricTaskError("task layer requires TaskSubjectV1", "layer_subject_mismatch", "harness");
  }
  if (outcome.routeSubject.subjectKind !== "route") {
    throw new FabricTaskError("nested route subject required", "layer_subject_mismatch", "harness");
  }
  if (!Number.isInteger(outcome.startedAt) || !Number.isInteger(outcome.completedAt) || outcome.completedAt < outcome.startedAt) {
    throw new FabricTaskError("invalid execution timestamps", "malformed_producer_outcome", "harness");
  }

  const paths = ensureLabDirs(opts.configDir);
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const authority = loadFabricCaseAuthority();
    const caseRecord = authority.cases[0]!;
    const scenarioDigest = fabricScenarioManifestDigest(caseRecord, authority);
    const suiteDigest = fabricSuiteManifestDigest(FABRIC_SUITE_ID, authority);
    const expandedScenario = expandFabricScenario(caseRecord, authority);
    const expandedSuite = expandFabricSuiteManifest(FABRIC_SUITE_ID, authority);
    const fixtureBytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
    const fixtureDigests = [fixtureDigest(fixtureBytes)];

    const artifacts: ReturnType<ArtifactStore["put"]>[] = [];
    artifacts.push(store.put({
      artifactClass: "fixture",
      payload: fixtureBytes,
      expectedDigest: fixtureDigests[0],
      mediaType: caseRecord.fixture.mediaType,
    }));
    artifacts.push(store.put({
      artifactClass: "scenario_manifest",
      payload: expandedScenario,
      expectedDigest: scenarioDigest,
    }));
    artifacts.push(store.put({
      artifactClass: "suite_manifest",
      payload: expandedSuite,
      expectedDigest: suiteDigest,
    }));
    artifacts.push(store.put({
      artifactClass: "verifier_summary",
      payload: {
        scenarioId: FABRIC_SCENARIO_ID,
        passed: outcome.verifier.passed,
        verifier: outcome.verifier,
        usage: outcome.usage,
        outcome: outcome.outcome,
      },
    }));

    const limits: Record<string, number | null> = {};
    for (const key of OBSERVATION_LIMIT_NAMES) {
      if (key in authority.manifestDefaults.executionLimits) {
        limits[key] = authority.manifestDefaults.executionLimits[key] ?? null;
      }
    }

    const recordedAt = opts.recordedAt ?? outcome.completedAt;
    const eventWithoutId = {
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "observation" as const,
      recordedAt,
      producer: LAB_PRODUCER,
      producerVersion: opts.producerVersion ?? LAB_PRODUCER_VERSION,
      evidenceLayer: FABRIC_EVIDENCE_LAYER,
      scenarioId: FABRIC_SCENARIO_ID,
      scenarioVersion: FABRIC_SCENARIO_VERSION,
      scenarioManifestDigest: scenarioDigest,
      suiteId: FABRIC_SUITE_ID,
      suiteVersion: FABRIC_SUITE_VERSION,
      suiteManifestDigest: suiteDigest,
      fixtureDigests,
      subject: outcome.taskSubject,
      subjectId: outcome.subjectId,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      executionMode: "fabric" as const,
      attempt: opts.attempt ?? 1,
      limits,
      outcome: outcome.outcome,
      assertions: [{
        id: "exact-tree-diff-pass",
        operator: "equals",
        required: true,
        passed: outcome.verifier.passed,
        expectedSummary: "pass",
        observedSummary: truncateUtf8(sanitizeDiagnostic(outcome.verifier.reason ?? (outcome.verifier.passed ? "pass" : "fail")), 512),
      }],
      environment: {
        runtime: {
          platform: process.platform,
          arch: process.arch,
          bunVersion: process.versions.bun ?? Bun.version,
        },
      },
      artifactRefs: artifacts,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(outcome.sourceRefs ? { sourceRefs: [...outcome.sourceRefs] } : {}),
    };
    return { event: assignEventId(eventWithoutId) as ObservationEvent, artifacts };
  } finally {
    if (ownsStore) store.close();
  }
}

export function persistFabricOutcome(
  outcome: FabricTaskOutcomeV1,
  opts: PersistFabricOptions = {},
): PersistedFabricObservation {
  const paths = ensureLabDirs(opts.configDir);
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const { event } = observationFromFabricOutcome(outcome, { ...opts, artifactStore: store });
    const replay = existsSync(paths.ledgerPath) ? replayLabLedger(paths.ledgerPath) : null;
    const alreadyPresent = replay?.events.some((row) => row.eventId === event.eventId) ?? false;
    if (!alreadyPresent) {
      appendLabEvent(paths.ledgerPath, event);
    }
    return { event, ledgerPath: paths.ledgerPath };
  } finally {
    if (ownsStore) store.close();
  }
}
