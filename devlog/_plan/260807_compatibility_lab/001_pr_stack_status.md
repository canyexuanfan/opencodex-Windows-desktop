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
| CL-00 | `feat/cl-00-compatibility-contracts` | `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296` | `163e21c3ca57c6f4a6381d00094e4fc23ae11e89` | [draft #1286](https://github.com/lidge-jun/opencodex/pull/1286) | ACCEPTED AFTER CODERABBIT REMEDIATION |
| CL-01 | `feat/cl-01-conformance-harness` | `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66` | `cc447ce9d19d5fb4e03988899f5fb495f9de8d0e` | [draft Wibias #10](https://github.com/Wibias/opencodex/pull/10) | ACCEPTED EARLIER; REBASE + CONTRACT CORRECTION REQUIRED |

The CL-01 starting SHA is the exact accepted CL-00 tip recorded by CL-01 when
its implementation began. Its PR base ref names the moving CL-00 branch; that
ref is not a substitute for the historical starting SHA above.

## CL-00 acceptance log

- Live-tree audit: complete against the exact base above. Audited provider
  registry/derivation, Routing Profile types/normalization/evaluator/API/UI/
  dry-run, route traces and Why-this-route, usage/request-history/analytics,
  doctor/provider connectivity validation, protocol regression tests, and
  relevant open/closed devlog incidents.
- Live-tree correction: generated Cursor task/grind protobuf messages exist,
  but no native Agent Fabric task persistence or management contract and no
  Compatibility Lab implementation exists. CL-00 freezes consumer semantics
  without claiming production endpoints. Future compatibility policy must
  extend the shipped Routing Profiles system.
- Documents:
  - `000_master_plan.md`
  - `010_architecture_and_evidence_contract.md`
  - `020_scenario_contract_and_catalogue.md`
  - `021_protocol_v1_manifest_authority.md`
  - `022_protocol_v1_cases.json`
  - `030_incident_corpus.md`
  - `040_security_and_privacy.md`
  - `050_cl00_acceptance_review.md` (refreshed after CodeRabbit re-review)
- Baseline verification on the original clean CL-00 worktree:
  - `bun x tsc --noEmit`: passed, 0 errors.
  - `bun run privacy:scan`: passed.
  - `bun run test`: **not green** on the Windows/Bun 1.3.14 host. The full
    run exited 3 after a cache-invalidation failure, an empty Windows
    effective-account lookup, and a Bun
    `panic(main thread): index out of bounds: index 0, len 0`.
  - Serial isolation:
    `tests/codex-models-cache-invalidate.test.ts` passed 6/6;
    `tests/codex-native-residue.test.ts` passed 63 with 2 platform skips.
  - Focused protocol/compatibility suite excluding privileged-symlink state
    cases: 395 passed, 0 failed across 24 files.
  - Focused continuation state semantics: 2 passed, 95 filtered, 0 failed.
  - A broader focused run including all `responses-state.test.ts` cases had
    488 pass and 4 fail; all four failures were Windows `EPERM` creating
    symlinks on that host.
  - `tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
- Original documentation verification: JSON authority parsed; all 35 cases,
  46 fixture records, eight suites and fixture digests validated; all local
  CL-00 links resolved; `git diff --check` passed.
- CodeRabbit remediation on 2026-08-08 validated and corrected all ten then-
  unresolved threads, including outside-diff security findings:
  - exact audit metadata;
  - deterministic array ordering in `BehaviorFingerprintV1`;
  - non-vacuous applicable-required verification;
  - source-protocol `[DONE]` semantics;
  - actual Chat `messages[].tool_call_id` result selectors;
  - immutable `LabDestinationV1` snapshot semantics;
  - empty inherited-environment allowlist plus upper/lower proxy rejection;
  - bounded custom-header fingerprinting;
  - shared contract-artifact retention across invalidation; and
  - matching security acceptance-test obligations.
- The selector-only `022` correction changes expanded scenario/suite manifest
  digests but no fixture bytes/digests. The acceptance review records this as a
  pre-release V1 contract correction.
- Independent CL-00 acceptance review: refreshed at
  `163e21c3ca57c6f4a6381d00094e4fc23ae11e89` after validating the CodeRabbit
  findings against current production code/contracts.
- Blockers: none for CL-00 contract acceptance. Full-suite green remains
  unavailable from the original Windows/Bun run for the documented unrelated
  host failures. Final GitHub CI/status and unresolved-thread state are checked
  after this ledger sync.
- CL-00 accepted contract SHA:
  `163e21c3ca57c6f4a6381d00094e4fc23ae11e89`; this status-ledger sync follows
  without changing the accepted contract semantics.
- Draft PR: [#1286](https://github.com/lidge-jun/opencodex/pull/1286).

## CL-01 impact of refreshed CL-00

CL-01 was independently accepted at
`cc447ce9d19d5fb4e03988899f5fb495f9de8d0e`, but it was built against the
older CL-00 tip `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66` and copied the old
Protocol V1 authority.

Before CL-01 can be stacked/merged it must:

1. rebase onto the refreshed CL-00 accepted contract head;
2. synchronize the two corrected Chat tool-result selectors in its copied
   `src/lab/conformance/fixtures/protocol-v1-cases.json`;
3. remove or narrow the harness-only Chat-wire `messages` -> synthetic
   Responses `input[]` observation projection that its acceptance review used
   to satisfy the old selectors;
4. align the SSE normalizer API/contract with source-protocol `[DONE]`
   selection rather than client-surface selection; and
5. rerun the canonical scenarios, negative controls, digest/manifest checks and
   CL-01 acceptance review.

This is a required CL-01 correction/revalidation, not CL-02 work.

## Authorization

- CL-00: **ACCEPTED AFTER CODERABBIT REMEDIATION**.
- CL-01: **EXISTS AND WAS ACCEPTED EARLIER, BUT MUST BE REBASED/CORRECTED BEFORE
  STACKING OR MERGE**.
- CL-02: **NOT STARTED / NOT AUTHORIZED BY THIS REMEDIATION**.
