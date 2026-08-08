# Compatibility Lab PR stack status

Updated throughout the programme. Every phase records its branch, exact
starting/base revision, accepted contract/implementation head, PR, verification,
independent review, blockers, and whether a later phase is authorized.

## Programme facts

- Repository: `lidge-jun/opencodex`
- Integration target: `dev`
- CL-00 starting `upstream/dev`:
  `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`
- Package/runtime at start: OpenCodex `2.10.2`, Bun `1.3.14`
- CL-00 branch: `feat/cl-00-compatibility-contracts`
- CL-00 scope: documentation/contracts/incident corpus only
- PR target: `lidge-jun/opencodex:dev`

## Stack

| Phase | Branch | Starting/base SHA | Accepted head | PR | State |
|---|---|---|---|---|---|
| CL-00 | `feat/cl-00-compatibility-contracts` | `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296` | `c014464237fd3c95bda08bc18bfab8ba8f532308` | [#1286](https://github.com/lidge-jun/opencodex/pull/1286) | ACCEPTED AFTER CODERABBIT REMEDIATION |
| CL-01 | `feat/cl-01-conformance-harness` | `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66` | `cc447ce9d19d5fb4e03988899f5fb495f9de8d0e` | [draft Wibias #10](https://github.com/Wibias/opencodex/pull/10) | ACCEPTED EARLIER; REBASE + CONTRACT CORRECTION + REVALIDATION REQUIRED |

The CL-01 starting SHA is the exact CL-00 tip recorded when CL-01 began. Its
moving base-ref name is not a substitute for that historical SHA.

## CL-00 acceptance log

- Live-tree audit covered provider registry/derivation, Routing Profiles,
  routing traces, request history/analytics, doctor/connectivity validation,
  protocol regression tests, and relevant incident/devlog records.
- CL-00 remains contract-only. No Compatibility Lab runtime, live runner,
  profile/router implementation, or CL-02 work was added.
- Contract documents:
  - `000_master_plan.md`
  - `010_architecture_and_evidence_contract.md`
  - `020_scenario_contract_and_catalogue.md`
  - `021_protocol_v1_manifest_authority.md`
  - `022_protocol_v1_cases.json`
  - `030_incident_corpus.md`
  - `040_security_and_privacy.md`
  - `050_cl00_acceptance_review.md`
- Original baseline verification:
  - `bun x tsc --noEmit`: passed.
  - `bun run privacy:scan`: passed.
  - `tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
  - focused protocol/compatibility: 395 passed, 0 failed across 24 files.
  - continuation semantics: 2 passed, 95 filtered, 0 failed.
  - isolated cache invalidation: 6 passed, 0 failed.
  - isolated native residue: 63 passed, 2 platform skips, 0 failed.
  - full `bun run test` was not green on the Windows/Bun 1.3.14 host for the
    previously documented cache/account/Bun panic failures; a broader
    `responses-state` run also had four Windows `EPERM` symlink failures.
- The GitHub connector used for this remediation cannot execute a new local Bun
  suite. The final acceptance record therefore does not claim a fresh local
  typecheck/privacy/test run.

### CodeRabbit remediation

The first unresolved-thread pass corrected:

- exact stack/audit revision metadata;
- deterministic `BehaviorFingerprintV1` array ordering;
- non-vacuous applicable-required verification;
- source-protocol `[DONE]` semantics;
- actual Chat `messages[].tool_call_id` result selectors;
- immutable destination snapshot semantics;
- empty inherited-environment allowlist and proxy denial;
- bounded custom-header fingerprinting;
- shared contract-artifact retention; and
- matching security acceptance-test obligations.

The second pass corrected additional deterministic/security gaps:

- closed invalidation payload/target semantics and privacy-safe purge tombstones;
- retained, replay-verifiable `ClaimSourceManifestV1` evidence;
- a total sidecar dependency sort including provider-instance fingerprint;
- machine-checkable synthetic fixture marker/provenance;
- exact closed MCP harness action tokens/semantics;
- destination-bound opaque credential leases that never expose secret bytes;
- hard, non-overridable V1 time/request/byte/token/tool/memory/process ceilings;
- descriptor/handle-bound no-follow Lab artifact validation/consumption; and
- sensitive-purge replay semantics that cannot preserve stale verdicts.

`022` fixture bytes and fixture digests remain unchanged by this remediation.
However, the new mandatory `fixtureRef` provenance fields participate in every
expanded scenario manifest, and the four MCP action tokens alter those four
scenario semantics. Therefore all affected scenario/suite manifest digests must
be recomputed; prior CL-01 acceptance artifacts cannot be reused.

Independent CL-00 acceptance review is frozen at
`c014464237fd3c95bda08bc18bfab8ba8f532308`. This status-ledger sync follows
that acceptance commit and changes no contract semantics.

## CL-01 impact of refreshed CL-00

CL-01 was independently accepted at
`cc447ce9d19d5fb4e03988899f5fb495f9de8d0e`, but it was built against older
CL-00 tip `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66` and copied the pre-remediation
Protocol V1 authority.

Before CL-01 can be stacked or merged it must:

1. rebase onto the final refreshed CL-00 branch;
2. synchronize both corrected Chat tool-result selectors;
3. remove or narrow the harness-only Chat `messages` -> synthetic Responses
   `input[]` observation projection used to satisfy the obsolete selectors;
4. select `[DONE]` semantics by source protocol rather than client surface;
5. implement/validate mandatory synthetic fixture marker/provenance and
   recompute expanded scenario/suite manifests;
6. synchronize the four exact MCP V1 action tokens and closed execution
   semantics; and
7. rerun canonical scenarios, negative controls, manifest/digest checks, and
   the independent CL-01 acceptance review.

This is a required CL-01 correction/revalidation. It is not CL-02 work.

## Authorization

- CL-00: **ACCEPTED AFTER CODERABBIT REMEDIATION**.
- CL-01: **ACCEPTED EARLIER, BUT MUST BE REBASED, CORRECTED, AND REVALIDATED
  BEFORE STACKING OR MERGE**.
- CL-02: **NOT STARTED / NOT AUTHORIZED BY THIS REMEDIATION**.
