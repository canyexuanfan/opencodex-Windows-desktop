/**
 * Persistence seam: transform CL-01 conformance results into valid observation events.
 * Deterministic harness execution stays separate from ledger persistence.
 */
import { createHash } from "node:crypto";
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  type ObservationOutcome,
} from "../constants";
import {
  jcsStringify,
  scenarioManifestDigest,
  subjectIdForSubject,
  suiteManifestDigest,
} from "../digest";
import type { ObservationEvent, ProtocolSubjectV1 } from "../events/types";
import { assignEventId } from "../events/validate";
import { appendLabEvent } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import type { CaseAuthority, CaseRecord, ScenarioRunResult } from "../conformance/types";
import { expandScenario } from "../conformance/manifest";
import { expandSuiteManifest } from "../conformance/suite-manifest";
import { fixtureDigest } from "../conformance/digest";

const PACKAGE_VERSION = "2.10.2";
const COMPAT_VERSION = "protocol-v1";

export interface PersistConformanceOptions {
  configDir?: string;
  recordedAt?: number;
  producerVersion?: string;
  artifactStore?: ArtifactStore;
}

export interface PersistedConformanceObservation {
  event: ObservationEvent;
  ledgerPath: string;
}

function behaviorFingerprintForCase(caseRecord: CaseRecord): string {
  const upstream = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const adapter = upstreamAdapter(upstream);
  const values = {
    schemaVersion: 1,
    resolverVersion: 1,
    values: {
      "wire.adapter": {
        source: "lab_forced",
        value: adapter,
      },
      "wire.upstreamProtocol": {
        source: "lab_forced",
        value: upstream,
      },
    },
  };
  return createHash("sha256").update(jcsStringify(values)).digest("hex");
}

function protocolSubject(caseRecord: CaseRecord): ProtocolSubjectV1 {
  const inbound = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const upstream = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const surface = caseRecord.requirements.surfaces[0] ?? "responses-http";
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: COMPAT_VERSION,
    effectiveAdapter: upstreamAdapter(upstream),
    inboundProtocol: inbound,
    upstreamProtocol: upstream,
    surface,
    behaviorFingerprint: behaviorFingerprintForCase(caseRecord),
  };
}

function upstreamAdapter(protocol: string): string {
  switch (protocol) {
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    default:
      return "openai-chat";
  }
}

function outcomeFromResult(result: ScenarioRunResult): ObservationOutcome {
  if (result.passed) return "pass";
  if (result.classification === "timeout" || result.classification === "budget_exhausted") {
    return "blocked";
  }
  if (result.classification === "inconclusive" || result.classification === "harness_failure") {
    return "inconclusive";
  }
  return "fail";
}

/**
 * Build a valid protocol_conformance observation from one CL-01 scenario result.
 * Does not append; use persistConformanceResult for ledger write.
 */
export function observationFromConformanceResult(
  result: ScenarioRunResult,
  caseRecord: CaseRecord,
  authority: CaseAuthority,
  opts: PersistConformanceOptions = {},
): { event: ObservationEvent; artifacts: ReturnType<ArtifactStore["put"]>[] } {
  const paths = ensureLabDirs(opts.configDir);
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  const recordedAt = opts.recordedAt ?? Date.now();
  const startedAt = recordedAt - 1;
  const completedAt = recordedAt;

  const expandedScenario = expandScenario(caseRecord, authority);
  const scenarioDigest = scenarioManifestDigest(expandedScenario);
  const suiteExpanded = expandSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>;
  const suiteDigest = suiteManifestDigest(suiteExpanded);

  const fixtureDigests: string[] = [];
  const artifacts: ReturnType<ArtifactStore["put"]>[] = [];

  const putFixture = (fixture: CaseRecord["fixture"]) => {
    const bytes = new TextEncoder().encode(fixture.bytesUtf8);
    const digest = fixtureDigest(bytes);
    fixtureDigests.push(digest);
    artifacts.push(
      store.put({
        artifactClass: "fixture",
        payload: bytes,
        expectedDigest: digest,
        mediaType: fixture.mediaType,
      }),
    );
  };
  putFixture(caseRecord.fixture);
  if (caseRecord.initiatingRequest) putFixture(caseRecord.initiatingRequest);

  artifacts.push(
    store.put({
      artifactClass: "scenario_manifest",
      payload: expandedScenario,
      expectedDigest: scenarioDigest,
    }),
  );
  artifacts.push(
    store.put({
      artifactClass: "suite_manifest",
      payload: suiteExpanded,
      expectedDigest: suiteDigest,
    }),
  );

  const assertionReport = store.put({
    artifactClass: "assertion_report",
    payload: {
      scenarioId: result.scenarioId,
      passed: result.passed,
      classification: result.classification,
      assertions: result.assertionResults.map((a) => ({
        id: a.id,
        operator: a.operator,
        required: a.required,
        passed: a.passed,
        observedSummary: a.observedSummary,
        reason: a.reason,
      })),
    },
  });
  artifacts.push(assertionReport);

  const subject = protocolSubject(caseRecord);
  const subjectId = subjectIdForSubject(subject);
  const outcome = outcomeFromResult(result);

  const eventWithoutId = {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt,
    producer: LAB_PRODUCER,
    producerVersion: opts.producerVersion ?? PACKAGE_VERSION,
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: caseRecord.id,
    scenarioVersion: String(authority.manifestDefaults.version),
    scenarioManifestDigest: scenarioDigest,
    suiteId: caseRecord.suite,
    suiteVersion: String(authority.manifestDefaults.suiteVersion),
    suiteManifestDigest: suiteDigest,
    fixtureDigests,
    subject,
    subjectId,
    startedAt,
    completedAt,
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { ...(authority.manifestDefaults.executionLimits as Record<string, number>) },
    outcome,
    assertions: result.assertionResults.map((a) => ({
      id: a.id,
      operator: a.operator,
      required: a.required,
      passed: a.passed,
      expectedSummary: "see_assertion_report",
      observedSummary: a.observedSummary.slice(0, 512),
      ...(a.reason ? { reason: a.reason } : {}),
    })),
    environment: {
      runtime: {
        platform: process.platform,
        arch: process.arch,
      },
    },
    artifactRefs: artifacts,
    ...(result.passed
      ? {}
      : {
          failure: {
            class: result.classification,
            code: result.secondaryCode ?? result.classification,
            retryable: false,
            attribution:
              result.classification === "harness_failure"
                ? ("harness" as const)
                : ("opencodex" as const),
          },
        }),
  };

  const event = assignEventId(eventWithoutId) as ObservationEvent;
  return { event, artifacts };
}

/** Transform → validate → append one CL-01 result into the canonical JSONL ledger. */
export function persistConformanceResult(
  result: ScenarioRunResult,
  caseRecord: CaseRecord,
  authority: CaseAuthority,
  opts: PersistConformanceOptions = {},
): PersistedConformanceObservation {
  const paths = ensureLabDirs(opts.configDir);
  const { event } = observationFromConformanceResult(result, caseRecord, authority, {
    ...opts,
    artifactStore: opts.artifactStore ?? createArtifactStore(paths.artifactsDir),
  });
  appendLabEvent(paths.ledgerPath, event);
  return { event, ledgerPath: paths.ledgerPath };
}
