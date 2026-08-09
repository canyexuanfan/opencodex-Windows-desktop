import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDigest } from "../conformance/digest";
import type {
  CaseAuthority,
  CaseRecord,
  FailureClassification,
  FailureRule,
} from "../conformance/types";
import { CL03_LIVE_SUITES, SYNTHETIC_MARKER } from "../conformance/types";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const AUTHORITY_FILE = "024_live_v1_cases.json";
const FIXTURES_DIR = join(MODULE_DIR, "..", "conformance", "fixtures");

export function loadLiveCaseAuthority(): CaseAuthority {
  const path = join(FIXTURES_DIR, "live-v1-cases.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as CaseAuthority;
  validateLiveAuthority(raw);
  return raw;
}

export function discoverLiveScenarios(
  authority: CaseAuthority,
  suites: readonly string[] = CL03_LIVE_SUITES,
): CaseRecord[] {
  return authority.cases.filter((c) => suites.includes(c.suite));
}

export function expandLiveScenario(caseRecord: CaseRecord, authority: CaseAuthority): Record<string, unknown> {
  const defaults = authority.manifestDefaults;
  const fixtures = caseRecord.initiatingRequest
    ? [fixtureRef(caseRecord.initiatingRequest, authority), fixtureRef(caseRecord.fixture, authority)]
    : [fixtureRef(caseRecord.fixture, authority)];
  return {
    schemaVersion: authority.schemaVersion,
    id: caseRecord.id,
    version: defaults.version,
    suite: {
      id: caseRecord.suite,
      version: defaults.suiteVersion,
      evidenceLayer: defaults.evidenceLayer,
    },
    evidenceLayer: defaults.evidenceLayer,
    capability: caseRecord.capability,
    verificationRole: caseRecord.verificationRole ?? defaults.verificationRole,
    requirements: caseRecord.requirements,
    fixtures,
    executionLimits: defaults.executionLimits,
    executionMode: defaults.executionMode,
    assertions: caseRecord.assertions,
    ...(caseRecord.expectedFailure ? { expectedFailure: caseRecord.expectedFailure } : {}),
    failureRules: expandLiveFailureRules(caseRecord, authority),
    artifactPolicy: defaults.artifactPolicy,
    freshness: defaults.freshness,
  };
}

function fixtureRef(fixture: CaseRecord["fixture"], authority: CaseAuthority): Record<string, unknown> {
  const bytes = new TextEncoder().encode(fixture.bytesUtf8);
  return {
    id: fixture.id,
    role: fixture.role,
    mediaType: fixture.mediaType,
    digest: fixture.digest,
    byteLength: bytes.byteLength,
    syntheticMarker: SYNTHETIC_MARKER,
    provenance: {
      kind: "lab_authored",
      authority: AUTHORITY_FILE,
      sourceCommit: authority.sourceCommit,
    },
  };
}

function expandLiveFailureRules(caseRecord: CaseRecord, authority: CaseAuthority): FailureRule[] {
  const setName = authority.manifestDefaults.failureRuleSet;
  const ruleSet = authority.failureRuleSets[setName];
  if (!Array.isArray(ruleSet)) {
    throw new Error(`harness_failure: contract_integrity unknown failureRuleSet ${setName}`);
  }
  const base = [...ruleSet];
  if (!caseRecord.expectedFailure) return base;
  const template = authority.expectedFailureRuleTemplate;
  const controlRule: FailureRule = {
    id: template.id,
    match: [...template.match],
    classification: caseRecord.expectedFailure.expectedClass as FailureClassification,
    secondaryCode: caseRecord.expectedFailure.expectedCode,
    verdictEffect: caseRecord.expectedFailure.onMatch === "unsupported" ? "unsupported" : "none",
    retry: template.retry,
    expected: template.expected,
  };
  const idx = base.findIndex((r) => r.id === "required-assertion");
  if (idx >= 0) base.splice(idx, 0, controlRule);
  else base.push(controlRule);
  return base;
}

function validateLiveAuthority(authority: CaseAuthority): void {
  if (authority.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  if (!authority.sourceCommit || typeof authority.sourceCommit !== "string") {
    throw new Error("missing sourceCommit");
  }
  if (!Array.isArray(authority.cases) || authority.cases.length === 0) throw new Error("no cases");
  if (authority.manifestDefaults.evidenceLayer !== "live_route_compatibility") {
    throw new Error("invalid evidenceLayer for live authority");
  }
  for (const caseRecord of authority.cases) {
    const bytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
    if (fixtureDigest(bytes) !== caseRecord.fixture.digest) {
      throw new Error(`${caseRecord.id}: fixture digest mismatch`);
    }
    if (caseRecord.initiatingRequest) {
      const initBytes = new TextEncoder().encode(caseRecord.initiatingRequest.bytesUtf8);
      if (fixtureDigest(initBytes) !== caseRecord.initiatingRequest.digest) {
        throw new Error(`${caseRecord.id}: initiatingRequest digest mismatch`);
      }
    }
    expandLiveScenario(caseRecord, authority);
  }
}
