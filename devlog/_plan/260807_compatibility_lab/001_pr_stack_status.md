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
| CL-00 | `feat/cl-00-compatibility-contracts` | `3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296` | `c014464237fd3c95bda08bc18bfab8ba8f532308` | [#1286](https://github.com/lidge-jun/opencodex/pull/1286) | ACCEPTED AFTER CODERABBIT REMEDIATION (merged to `dev` at `243c3f4905797aa11c62ba933bb03d6d721266fd`) |
| CL-01 | `feat/cl-01-conformance-harness` | `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66` | `22d608c82d82e2746c0cef9cd761db19a8e465ee` | [#1320](https://github.com/lidge-jun/opencodex/pull/1320) | MERGED TO `dev` at `4bb249b756abd468c675d2d92fffe4da95ad3e2a` |
| CL-02 | `feat/cl-02-evidence-ledger` | `4bb249b756abd468c675d2d92fffe4da95ad3e2a` | NOT RECORDED | [#1333](https://github.com/lidge-jun/opencodex/pull/1333) | MERGED TO `dev` at `025c37916225dd685d9217e5b40190600f06d278`; POST-MERGE HARDENING [#1343](https://github.com/lidge-jun/opencodex/pull/1343) MERGED at `eee2dab4d1bbacefce56057adad51d734f346702`; FINAL CLOSURE GATE [#1348](https://github.com/lidge-jun/opencodex/pull/1348) |
| CL-03 | `feat/cl-03-live-route-probes` | `4f746d13799888ea0a8c7a111aa2ad61c2126ea0` | — | — | IN PROGRESS (implementation) |

The CL-01 starting SHA is the exact CL-00 tip recorded when CL-01 began. Its
moving base-ref name is not a substitute for that historical SHA.

CL-02 starts from the exact CL-01 merge commit on `dev`
(`4bb249b756abd468c675d2d92fffe4da95ad3e2a` / upstream #1320). It does **not**
base on the pre-merge CL-01 feature branch tip.

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

Independent CL-00 acceptance review is frozen at
`c014464237fd3c95bda08bc18bfab8ba8f532308`. Merged to `dev` via #1286.

## CL-01 contract-correction log (2026-08-09)

- **Pre-rebase CL-01 head:** `cc447ce9d19d5fb4e03988899f5fb495f9de8d0e` (earlier accepted revision)
- **CL-00 merge base on `dev`:** `243c3f4905797aa11c62ba933bb03d6d721266fd`
- **Post-rebase harness commit:** `cfe27b0dcb26a1bf0bb56f68f952e6e4f4d80fe9` (rebase-only)
- **Correction head:** `574f1d5eb93c091494549ffc0e26ea7a4879c12c` (implementation); **tip:** `22d608c82d82e2746c0cef9cd761db19a8e465ee`
- **Merged to `dev`:** `4bb249b756abd468c675d2d92fffe4da95ad3e2a` via upstream [#1320](https://github.com/lidge-jun/opencodex/pull/1320).

### Corrections applied

1. Rebased onto merged CL-00 / #1286 (`243c3f490`).
2. Synced `022_protocol_v1_cases.json` runtime copy with final CL-00 authority.
3. Removed Chat → Responses `input[]` observation projection.
4. Chat tool-result selectors: `/upstream/requests/1/json/messages/1/tool_call_id` for function-round-trip and apply-patch-turn.
5. SSE `[DONE]` normalization keyed by source protocol (`openai-chat` only).
6. Mandatory synthetic fixture marker/provenance in expanded manifests; fail-closed validation.
7. Four deterministic MCP action tokens in `mcp-stub.ts`.
8. Recomputed scenario manifest digests (provenance participates in JCS expansion).
9. Narrow image tool-result wire normalization for `tools-core.protocol.result-content` (indices only).
10. `openai-chat.ts`: `toolResultTextForWire` omits `[image]` marker when images are flushed to user carrier.

### Verification (correction)

- `bun x tsc --noEmit`: passed
- `bun test tests/lab-conformance-harness.test.ts`: 14/14 passed
- `git diff --check`: passed
- Independent review: `051_cl01_acceptance_review.md` — ACCEPTED (revalidation)

### Blockers

- None for CL-01 correction.
- Full-suite green remains unavailable on this host for documented Windows/Bun reasons.

## CL-02 implementation log

- **Branch:** `feat/cl-02-evidence-ledger`
- **Starting/base SHA:** `4bb249b756abd468c675d2d92fffe4da95ad3e2a` (CL-01 merge via #1320)
- **Merged source head:** `1eed4ffbc9772c64f4f22e37869ccb0b9efa90e1`
- **Merged to `dev`:** `025c37916225dd685d9217e5b40190600f06d278` via upstream [#1333](https://github.com/lidge-jun/opencodex/pull/1333).
- **Accepted head:** not recorded. #1333 was merged before an independent-acceptance state was observed in this programme log.
- **Scope:** append-only JSONL evidence ledger with an explicit sensitive-purge
  exception: when the `ledger` purge action is requested, targeted evidence is
  physically removed by atomic ledger rewrite and a `purge_tombstone` remains as
  the auditable record; SQLite is rebuilt from the rewritten ledger and retained
  content-addressed artifacts. The phase also includes the content-addressed
  artifact store, disposable/rebuildable SQLite projection, ClaimSourceManifestV1,
  invalidation semantics, and the CL-01 → observation persistence seam.
- **Explicitly out of scope:** CL-03 live probes, CL-04 CLI/API, CL-05 UI,
  CL-06 profile fields, Fabric, shadow workflows.

### Boundary note (verdict algorithm)

CL-02 implements frozen `all-applicable-required-pass-v1` evaluation with
subject-aware applicability (required scenarios whose manifest requirements
match the exact protocol subject, excluding live-reserved cases in fixture
mode). Positive `VERIFIED` requires a non-empty applicable required set and a
current pass for every member. Descriptor/handle-bound artifact I/O, fail-closed
sensitive purge with shared-artifact retention, recursive event admission
ceilings, and unusable-evidence exclusion from projection are implemented.
Claims cannot produce `PROBED`/`VERIFIED`.

### CL-02 validation and post-merge hardening status (2026-08-09)

- **Prior accepted review-fix head:** `cf626d14c823413fbcd6ac2625d1da16bbac714e`
- **Final #1333 source head:** `1eed4ffbc9772c64f4f22e37869ccb0b9efa90e1`
- **#1333 merge commit:** `025c37916225dd685d9217e5b40190600f06d278`
- A final CodeRabbit review batch arrived immediately before the #1333 merge and
  identified additional hardening work in ledger replay, artifact publication,
  sensitive purge, event privacy admission, contract-artifact error
  classification, conformance execution timestamps, and regression coverage.
- **Post-merge hardening branch:** `fix/cl-02-post-merge-hardening`
- **Post-merge hardening PR:** [#1343](https://github.com/lidge-jun/opencodex/pull/1343), based exactly on #1333 merge commit `025c37916225dd685d9217e5b40190600f06d278`.
- **Final #1343 source head:** `953e75f498056edabb9c4f2b33945f6a3d081780`.
- **#1343 merged to `dev`:** `eee2dab4d1bbacefce56057adad51d734f346702` on 2026-08-09.
- #1343 preserved frozen CL-00 semantics and did not add CL-03 work.
- React Doctor for final #1343 head passed. Cross-platform CI run `31305383591`
  remained in progress when the closure follow-up was opened; its completed jobs
  included green gates/typecheck/privacy and green test shards 1/4, 2/4, and 4/4.
- One final CodeRabbit test-quality finding remained on the merged PR: the
  targetless purge validation regression asserted only `LabValidationError`
  rather than the exact `empty_purge_targets` code.
- **Closure branch:** `fix/cl-02-closure-final`, based on then-current `dev`
  `f197529c7d8c6adbaf3f859547414698d349340d`, which contains #1343.
- **Closure PR:** [#1348](https://github.com/lidge-jun/opencodex/pull/1348).
- #1348 strengthens the purge regression to assert the exact error code and
  records the closure gate in `053_cl02_closure_gate.md`.
- **CL-03:** not started. Authorization requires #1348 green CI, zero unresolved
  valid CodeRabbit findings, and merge to `dev`.

## Authorization

- CL-00: **ACCEPTED** (merged #1286).
- CL-01: **MERGED** via #1320 at `4bb249b756abd468c675d2d92fffe4da95ad3e2a`.
- CL-02: **MERGED** via #1333 at `025c37916225dd685d9217e5b40190600f06d278`; post-merge hardening #1343 is also **MERGED** at `eee2dab4d1bbacefce56057adad51d734f346702`; final closure is tracked in #1348.
- CL-03: **IN PROGRESS** on `feat/cl-03-live-route-probes` from `4f746d13799888ea0a8c7a111aa2ad61c2126ea0`.
