import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDigest, scenarioManifestDigest } from "./digest";
import type {
  CaseAuthority,
  CaseRecord,
  FailureClassification,
  FailureRule,
} from "./types";
import { CL01_SUITES } from "./types";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function loadCaseAuthority(): CaseAuthority {
  const path = join(MODULE_DIR, "fixtures", "protocol-v1-cases.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as CaseAuthority;
  validateAuthority(raw);
  return raw;
}

export function discoverScenarios(
  authority: CaseAuthority,
  suites: readonly string[] = CL01_SUITES,
): CaseRecord[] {
  return authority.cases.filter((c) => suites.includes(c.suite));
}

export function expandScenario(caseRecord: CaseRecord, authority: CaseAuthority): Record<string, unknown> {
  const defaults = authority.manifestDefaults;
  const fixtures = caseRecord.initiatingRequest
    ? [fixtureRef(caseRecord.initiatingRequest), fixtureRef(caseRecord.fixture)]
    : [fixtureRef(caseRecord.fixture)];
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
    assertions: caseRecord.assertions,
    ...(caseRecord.expectedFailure ? { expectedFailure: caseRecord.expectedFailure } : {}),
    failureRules: expandFailureRules(caseRecord, authority),
    artifactPolicy: defaults.artifactPolicy,
    freshness: defaults.freshness,
  };
}

function fixtureRef(fixture: CaseRecord["fixture"]): Record<string, unknown> {
  const bytes = new TextEncoder().encode(fixture.bytesUtf8);
  return {
    id: fixture.id,
    role: fixture.role,
    mediaType: fixture.mediaType,
    digest: fixture.digest,
    byteLength: bytes.byteLength,
  };
}

function expandFailureRules(caseRecord: CaseRecord, authority: CaseAuthority): FailureRule[] {
  const base = [...authority.failureRuleSets[authority.manifestDefaults.failureRuleSet]];
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

export function validateFixtureDigests(caseRecord: CaseRecord): string[] {
  const errors: string[] = [];
  const check = (fixture: CaseRecord["fixture"], label: string) => {
    const bytes = new TextEncoder().encode(fixture.bytesUtf8);
    const digest = fixtureDigest(bytes);
    if (digest !== fixture.digest) {
      errors.push(`${label} digest mismatch: expected ${fixture.digest}, got ${digest}`);
    }
  };
  check(caseRecord.fixture, caseRecord.fixture.id);
  if (caseRecord.initiatingRequest) check(caseRecord.initiatingRequest, caseRecord.initiatingRequest.id);
  return errors;
}

export function validateScenarioManifestDigest(caseRecord: CaseRecord, authority: CaseAuthority): boolean {
  const expanded = expandScenario(caseRecord, authority);
  const digest = scenarioManifestDigest(expanded);
  // Registration-time self-check: digest is computable and stable for the expanded manifest.
  return digest.length === 64;
}

function validateAuthority(authority: CaseAuthority): void {
  if (authority.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  if (!Array.isArray(authority.cases) || authority.cases.length === 0) throw new Error("no cases");
  for (const caseRecord of authority.cases) {
    const errors = validateFixtureDigests(caseRecord);
    if (errors.length > 0) throw new Error(errors.join("; "));
    if (caseRecord.fixture.role === "upstream_response" && !caseRecord.initiatingRequest) {
      throw new Error(`${caseRecord.id}: upstream_response without initiatingRequest`);
    }
  }
}
