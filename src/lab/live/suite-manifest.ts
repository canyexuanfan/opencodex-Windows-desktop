import { scenarioManifestDigest, suiteManifestDigest } from "../digest";
import type { CaseAuthority, CaseRecord, VerificationRole } from "../conformance/types";
import { expandLiveScenario } from "./manifest";

export interface LiveSuiteScenarioRefV1 {
  id: string;
  version: string;
  role: VerificationRole;
  manifestDigest: string;
}

export interface LiveSuiteManifestV1 {
  schemaVersion: 1;
  id: string;
  version: string;
  evidenceLayer: string;
  capability: string;
  assertionDslVersion: string;
  evidenceSchemaVersion: string;
  freshness: { maxAgeMs: number | null };
  contradictionRule: string;
  scenarios: LiveSuiteScenarioRefV1[];
  verificationRule: string;
}

export function expandLiveSuiteManifest(
  suiteId: string,
  authority: CaseAuthority,
): LiveSuiteManifestV1 {
  const cases = authority.cases.filter((c) => c.suite === suiteId);
  if (cases.length === 0) throw new Error(`unknown live suite ${suiteId}`);
  const defaults = authority.manifestDefaults;
  const capability = cases[0]!.capability;
  const scenarios: LiveSuiteScenarioRefV1[] = cases
    .map((caseRecord) => ({
      id: caseRecord.id,
      version: String(defaults.version),
      role: caseRecord.verificationRole ?? defaults.verificationRole,
      manifestDigest: scenarioManifestDigest(expandLiveScenario(caseRecord, authority)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: 1,
    id: suiteId,
    version: String(defaults.suiteVersion),
    evidenceLayer: defaults.evidenceLayer,
    capability,
    assertionDslVersion: authority.assertionDslVersion,
    evidenceSchemaVersion: authority.evidenceSchemaVersion,
    freshness: defaults.freshness ?? { maxAgeMs: null },
    contradictionRule: "newest-required-observation-v1",
    scenarios,
    verificationRule: "all-applicable-required-pass-v1",
  };
}

export function liveSuiteManifestObjectForCase(
  caseRecord: CaseRecord,
  authority: CaseAuthority,
): Record<string, unknown> {
  return expandLiveSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>;
}

export function liveSuiteManifestDigestForCase(caseRecord: CaseRecord, authority: CaseAuthority): string {
  return suiteManifestDigest(expandLiveSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>);
}
