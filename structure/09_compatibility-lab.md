# Compatibility Lab SOT

## CL-03 live-route execution boundary

CL-03 live-route evidence is generated only for an exact `RouteSubjectV1` and remains separate from protocol-conformance and task-effectiveness evidence.

The live runner fails closed before destination resolution unless the selected scenario is applicable and every route precondition, including explicit `lab_run_approval`, is satisfied. Destination resolution is bounded by the CL-03 connect timeout, policy-checks every resolved address, freezes the approved address set, and fingerprints only the immutable destination snapshot. Raw URLs and resolved addresses are not persisted as Lab evidence.

Evidence-eligible route execution uses a host-issued `TrustedLabRouteExecutor`. The public Lab authority surface only recognizes host-issued capabilities; it does not expose a constructor that accepts caller-asserted sandbox boundary names. Test transports remain useful for normalization/classification tests but are never evidence-eligible.

Successful or blocked trusted executions receive a module-private receipt bound to the canonical live authority, scenario ID, suite ID, scenario/suite manifest digests, and exact route subject ID. `observationFromLiveResult` verifies that receipt before creating directories or writing artifacts, so a structural `LiveScenarioRunResult` or mismatched case/authority cannot fabricate live evidence.

The trusted credential sender keeps secret injection outside Lab code and uses the existing pinned HTTP primitive. CL-03 explicitly supplies its connect timeout; other pinned-HTTP callers retain their prior timeout behavior. Only response metadata required by live assertions currently crosses back into Lab (`content-type`); cookies, account/organization metadata, credential-adjacent headers, and rate-limit headers are not exposed.

Live projection preserves the frozen `RouteSubjectV1` schema. Claim-gated scenario applicability is derived from current validated, usable `claim_snapshot` state for the exact subject rather than from caller-provided claim arrays or by extending the V1 subject preimage. A missing/wrong-kind route subject or unavailable claim state fails verification closed.

The two machine-readable Live V1 authority copies are required to be byte-identical. Runtime loading fails closed on byte drift before parsing. Scenario limits use `perArtifactBytes` as the single per-artifact execution-limit key; the artifact policy retains its independent per-artifact policy ceiling.

## Scope guard

CL-03 does not expose a management CLI/API or UI. Those surfaces remain CL-04+ work. Production request routing must not synchronously trigger Compatibility Lab probing or rebuild Lab evidence.
