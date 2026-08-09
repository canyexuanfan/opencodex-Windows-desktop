/**
 * Persistence seam: transform CL-01 conformance results into valid observation events.
 * Deterministic harness execution stays separate from ledger persistence.
 */
import { createHash } from "node:crypto";
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PRODUCER_VERSION,
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
import type {
  CaseAuthority,
  CaseRecord,
  ProtocolExecutionContextV1,
  ScenarioRunResult,
} from "../conformance/types";
import { expandScenario } from "../conformance/manifest";
import { suiteManifestObjectForCase } from "../conformance/suite-manifest";
import { fixtureDigest } from "../conformance/digest";
import { resolveProtocolExecutionContext } from "../conformance/executor";

const COMPAT_VERSION = "protocol-v1";

type TimedScenarioRunResult = ScenarioRunResult & {
  startedAt?: number;
  completedAt?: number;
};

export interface PersistConformanceOptions {
  configDir?: string;
  recordedAt?: number;
  /** Actual execution timestamps from the CL-01 runner; never fabricated. */
  startedAt?: number;
  completedAt?: number;
  producerVersion?: string;
  artifactStore?: ArtifactStore;
}

export interface PersistedConformanceObservation {
  event: ObservationEvent;
  ledgerPath: string;
}

function validateExecutionContext(
  caseRecord: CaseRecord,
  ctx: ProtocolExecutionContextV1,
): ProtocolExecutionContextV1 {
  const checks: Array<[string, string[], string]> = [
    ["inboundProtocols", caseRecord.requirements.inboundProtocols, ctx.inboundProtocol],
    ["upstreamProtocols", caseRecord.requirements.upstreamProtocols, ctx.upstreamProtocol],
    ["surfaces", caseRecord.requirements.surfaces, ctx.surface],
  ];
  for (const [name, declared, actual] of checks) {
    if (declared.length === 0) throw new Error(`case ${caseRecord.id} has empty ${name}`);
    if (!declared.includes(actual)) {
      throw new Error(`case ${caseRecord.id} execution context violates ${name}`);
    }
  }
  return ctx;
}

function behaviorFingerprintForCase(
  caseRecord: CaseRecord,
  executionContext?: ProtocolExecutionContextV1,
): string {
  const ctx = validateExecutionContext(
    caseRecord,
    executionContext ?? resolveProtocolExecutionContext(caseRecord),
  );
  const adapter = upstreamAdapter(ctx.upstreamProtocol);
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
        value: ctx.upstreamProtocol,
      },
      "runtime.arch": {
        source: "lab_forced",
        value: process.arch,
      },
      "runtime.bunVersion": {
        source: "lab_forced",
        value: process.versions.bun ?? Bun.version,
      },
      "runtime.platform": {
        source: "lab_forced",
        value: process.platform,
      },
    },
  };
  return createHash("sha256").update(jcsStringify(values)).digest("hex");
}

function protocolSubject(caseRecord: CaseRecord, result: ScenarioRunResult): ProtocolSubjectV1 {
  const ctx = validateExecutionContext(
    caseRecord,
    result.executionContext ?? resolveProtocolExecutionContext(caseRecord),
  );
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: COMPAT_VERSION,
    effectiveAdapter: upstreamAdapter(ctx.upstreamProtocol),
    inboundProtocol: ctx.inboundProtocol,
    upstreamProtocol: ctx.upstreamProtocol,
    surface: ctx.surface,
    behaviorFingerprint: behaviorFingerprintForCase(caseRecord, ctx),
  };
}

function upstreamAdapter(protocol: string): string {
  switch (protocol) {
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    case "openai-chat":
      return "openai-chat";
    default:
      throw new Error(`unsupported protocol identity: ${protocol}`);
  }
}

function outcomeFromResult(result: ScenarioRunResult): ObservationOutcome {
  if (result.passed) return "pass";
  switch (result.classification) {
    case "timeout":
    case "budget_exhausted":
      return "blocked";
    case "inconclusive":
    case "harness_failure":
      return "inconclusive";
    case "protocol_failure":
    case "capability_failure":
    case "behavioral_failure":
      return "fail";
    default: {
      const _never: never = result.classification;
      return _never;
    }
  }
}

function requireExecutionTimes(
  result: ScenarioRunResult,
  opts: PersistConformanceOptions,
): { startedAt: number; completedAt: number } {
  const timed = result as TimedScenarioRunResult;
  const startedAt = opts.startedAt ?? timed.startedAt;
  const completedAt = opts.completedAt ?? timed.completedAt;
  if (!Number.isInteger(startedAt) || !Number.isInteger(completedAt)) {
    throw new Error("real startedAt/completedAt are required for persisted conformance evidence");
  }
  if (startedAt! < 0 || completedAt! < startedAt!) {
    throw new Error("invalid persisted conformance execution timestamps");
  }
  return { startedAt: startedAt!, completedAt: completedAt! };
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
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const { startedAt, completedAt } = requireExecutionTimes(result, opts);
    const recordedAt = opts.recordedAt ?? completedAt;

    const expandedScenario = expandScenario(caseRecord, authority);
    const scenarioDigest = scenarioManifestDigest(expandedScenario);
    const suiteExpanded = suiteManifestObjectForCase(caseRecord, authority);
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

    const subject = protocolSubject(caseRecord, result);
    const subjectId = subjectIdForSubject(subject);
    const outcome = outcomeFromResult(result);
    const authorityLimits = authority.manifestDefaults.executionLimits;

    const eventWithoutId = {
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "observation" as const,
      recordedAt,
      producer: LAB_PRODUCER,
      producerVersion: opts.producerVersion ?? LAB_PRODUCER_VERSION,
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
      limits: { ...authorityLimits },
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
      ...(caseRecord.expectedFailure
        ? { expectedFailure: { ...caseRecord.expectedFailure } }
        : {}),
      environment: {
        runtime: {
          platform: process.platform,
          arch: process.arch,
          bunVersion: process.versions.bun ?? Bun.version,
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
  } finally {
    if (ownsStore) store.close();
  }
}

/** Transform → validate → append one CL-01 result into the canonical JSONL ledger. */
export function persistConformanceResult(
  result: ScenarioRunResult,
  caseRecord: CaseRecord,
  authority: CaseAuthority,
  opts: PersistConformanceOptions = {},
): PersistedConformanceObservation {
  const paths = ensureLabDirs(opts.configDir);
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const { event } = observationFromConformanceResult(result, caseRecord, authority, {
      ...opts,
      artifactStore: store,
    });
    appendLabEvent(paths.ledgerPath, event);
    return { event, ledgerPath: paths.ledgerPath };
  } finally {
    if (ownsStore) store.close();
  }
}

export { behaviorFingerprintForCase };
