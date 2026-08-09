// CL-03 live result -> CL-02 immutable observation persistence.
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import { LAB_EVENT_SCHEMA_VERSION, LAB_PRODUCER, LAB_PRODUCER_VERSION, OBSERVATION_LIMIT_NAMES, type ObservationOutcome } from "../constants";
import { fixtureDigest, scenarioManifestDigest, subjectIdForSubject, suiteManifestDigest } from "../digest";
import type { ObservationEvent } from "../events/types";
import { assignEventId } from "../events/validate";
import { appendLabEvent } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import type { CaseAuthority, CaseRecord } from "../conformance/types";
import { expandLiveScenario } from "../live/manifest";
import { liveSuiteManifestObjectForCase } from "../live/suite-manifest";
import type { LiveScenarioRunResult } from "../live/types";

export interface PersistLiveOptions { configDir?: string; recordedAt?: number; startedAt?: number; completedAt?: number; producerVersion?: string; artifactStore?: ArtifactStore }
export interface PersistedLiveObservation { event: ObservationEvent; ledgerPath: string }

function outcomeFromLiveResult(result: LiveScenarioRunResult): ObservationOutcome {
  if (result.passed) return "pass";
  if (["timeout", "budget_exhausted", "authentication_blocked", "quota_blocked", "region_blocked", "network_failure", "provider_transient"].includes(result.classification)) return "blocked";
  if (["inconclusive", "harness_failure"].includes(result.classification)) return "inconclusive";
  if (["protocol_failure", "capability_failure", "behavioral_failure"].includes(result.classification)) return "fail";
  return "inconclusive";
}

function requireExecutionTimes(result: LiveScenarioRunResult, opts: PersistLiveOptions): { startedAt: number; completedAt: number } {
  const startedAt = opts.startedAt ?? result.startedAt; const completedAt = opts.completedAt ?? result.completedAt;
  if (!Number.isInteger(startedAt) || !Number.isInteger(completedAt) || startedAt < 0 || completedAt < startedAt) throw new Error("invalid persisted live execution timestamps");
  return { startedAt, completedAt };
}

export function observationFromLiveResult(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, opts: PersistLiveOptions = {}): { event: ObservationEvent; artifacts: ReturnType<ArtifactStore["put"]>[] } {
  if (!result.routeSubject) throw new Error("live evidence without an exact RouteSubjectV1 is not persistable");
  const paths = ensureLabDirs(opts.configDir); const ownsStore = !opts.artifactStore; const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const { startedAt, completedAt } = requireExecutionTimes(result, opts); const recordedAt = opts.recordedAt ?? completedAt;
    const expandedScenario = expandLiveScenario(caseRecord, authority); const scenarioDigest = scenarioManifestDigest(expandedScenario);
    const suiteExpanded = liveSuiteManifestObjectForCase(caseRecord, authority); const suiteDigest = suiteManifestDigest(suiteExpanded);
    const fixtureDigests: string[] = []; const artifacts: ReturnType<ArtifactStore["put"]>[] = [];
    const putFixture = (fixture: CaseRecord["fixture"]) => {
      const bytes = new TextEncoder().encode(fixture.bytesUtf8); const digest = fixtureDigest(bytes); fixtureDigests.push(digest);
      artifacts.push(store.put({ artifactClass: "fixture", payload: bytes, expectedDigest: digest, mediaType: fixture.mediaType }));
    };
    putFixture(caseRecord.fixture); if (caseRecord.initiatingRequest) putFixture(caseRecord.initiatingRequest);
    artifacts.push(store.put({ artifactClass: "scenario_manifest", payload: expandedScenario, expectedDigest: scenarioDigest }));
    artifacts.push(store.put({ artifactClass: "suite_manifest", payload: suiteExpanded, expectedDigest: suiteDigest }));
    artifacts.push(store.put({ artifactClass: "assertion_report", payload: { scenarioId: result.scenarioId, passed: result.passed, classification: result.classification,
      assertions: result.assertionResults.map((row) => ({ id: row.id, operator: row.operator, required: row.required, passed: row.passed, observedSummary: row.observedSummary, reason: row.reason })) } }));
    const subject = result.routeSubject; const subjectId = subjectIdForSubject(subject); const authorityLimits = authority.manifestDefaults.executionLimits;
    const limits: Record<string, number | null> = {}; for (const key of OBSERVATION_LIMIT_NAMES) if (key in authorityLimits) limits[key] = authorityLimits[key] ?? null;
    const eventWithoutId = {
      schemaVersion: LAB_EVENT_SCHEMA_VERSION, eventKind: "observation" as const, recordedAt, producer: LAB_PRODUCER, producerVersion: opts.producerVersion ?? LAB_PRODUCER_VERSION,
      evidenceLayer: "live_route_compatibility" as const, scenarioId: caseRecord.id, scenarioVersion: String(authority.manifestDefaults.version), scenarioManifestDigest: scenarioDigest,
      suiteId: caseRecord.suite, suiteVersion: String(authority.manifestDefaults.suiteVersion), suiteManifestDigest: suiteDigest, fixtureDigests, subject, subjectId,
      startedAt, completedAt, executionMode: "live" as const, attempt: 1, limits, outcome: outcomeFromLiveResult(result),
      assertions: result.assertionResults.map((row) => ({ id: row.id, operator: row.operator, required: row.required, passed: row.passed, expectedSummary: "see_assertion_report", observedSummary: row.observedSummary.slice(0, 512), ...(row.reason ? { reason: row.reason } : {}) })),
      ...(caseRecord.expectedFailure ? { expectedFailure: { ...caseRecord.expectedFailure } } : {}),
      environment: { runtime: { platform: process.platform, arch: process.arch, bunVersion: process.versions.bun ?? Bun.version } }, artifactRefs: artifacts,
      ...(result.passed ? {} : { failure: { class: result.classification, code: result.secondaryCode ?? result.classification, retryable: false,
        attribution: result.classification === "harness_failure" ? "harness" as const : ["authentication_blocked", "quota_blocked", "region_blocked", "network_failure", "provider_transient", "timeout", "budget_exhausted"].includes(result.classification) ? "environment" as const : "route" as const } }),
    };
    return { event: assignEventId(eventWithoutId) as ObservationEvent, artifacts };
  } finally { if (ownsStore) store.close(); }
}

export function persistLiveResult(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, opts: PersistLiveOptions = {}): PersistedLiveObservation {
  const paths = ensureLabDirs(opts.configDir); const ownsStore = !opts.artifactStore; const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try { const { event } = observationFromLiveResult(result, caseRecord, authority, { ...opts, artifactStore: store }); appendLabEvent(paths.ledgerPath, event); return { event, ledgerPath: paths.ledgerPath }; }
  finally { if (ownsStore) store.close(); }
}
