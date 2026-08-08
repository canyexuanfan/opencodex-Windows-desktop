# CL-00 independent acceptance review

Date: 2026-08-08

Scope: the complete CL-00 contract set on
`feat/cl-00-compatibility-contracts`, based on
`3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`. The initial delayed-review
acceptance was recorded at `12e50a3502fb4af25283538cc717ead2291edd8b`.
A later CodeRabbit re-review was validated against current production code and
contract semantics; its accepted contract corrections are incorporated through
`b62e29395d25b2cd9a1dfd852101dbf7a2c91507` and this record supersedes the
stale acceptance/status statements from the earlier pass.

The review was read-only and separate from the original authoring pass. Every
validated Critical, High, and Medium finding was corrected and re-reviewed
before this record was finalized. Valid deterministic/security contract defects
were also corrected even when review severity was lower.

## Findings and corrections

### Critical

None.

### High

1. Initial scenario prose did not define executable selector/operator semantics
   or canonical per-case manifests.
   - Correction: added the closed assertion/selector/SSE contract in `021` and
     the 35-case machine-readable authority in `022`, with literal fixtures,
     expected values, row-specific requirements, roles, media types, limits,
     artifact policy, and failure rules.
2. Immutable observations lacked enough manifest/fixture provenance to
   reproduce `VERIFIED`.
   - Correction: observations now carry scenario, suite, and fixture digests;
     domain-separated digest preimages are exact; referenced manifests and
     fixtures are retained content-addressably and cannot be replaced by the
     current version during replay.
3. Route identity did not close compatibility-version and sidecar-dependent
   behavior.
   - Correction: froze the compatibility-version manifest/preimage, included
     effective runtime and sidecar settings, added flat dependency identities,
     and kept route-local endpoints in the composite subject rather than the
     provider-independent scenario manifest.
4. Response-only protocol vectors did not identify an initiating client
   request.
   - Correction: added 11 explicit initiating request fixtures. All
     `upstream_response` cases now have one request that fixes model, input,
     stream mode, and inbound surface.
5. Named verifier values had no deterministic derivation.
   - Correction: defined every V1 verifier as a closed pure function over the
     current synthetic fixture and normalized observation.
6. Catalogue prose and incident mappings initially implied coverage beyond the
   literal V1 assertions.
   - Correction: narrowed every protocol V1 row to its exact `022` evidence and
     made incident mappings explicit future scenario/version inputs when no
     literal V1 vector exists.
7. The three evidence layers lacked separate executable subject identities,
   and suites could span layers.
   - Correction: added the closed `ProtocolSubjectV1`, `RouteSubjectV1`, and
     `TaskSubjectV1` union, exact layer/subject matching, layer-qualified suite
     manifests, and one reserved deterministic Fabric task/verifier contract.
8. Behavior identity did not explicitly close effective
   `commandCodeVersion`, sampling-parameter omission sets, `cacheRetention`, or
   unknown future behavior inputs.
   - Correction: froze `BehaviorFingerprintV1`, its closed keys and source
     tags, required values from the production resolver, and fail-closed
     handling/tests for an unclassified behavior input.
9. A global protocol failure-rule list attached both control effects to every
   case, violating the legal control matrix.
   - Correction: the base rule set contains no control rule; expansion adds
     exactly one materialized rule only for a case with `expectedFailure`.
     Protocol V1 has one conformance control and no unsupported effect.
10. Tool/MCP assertions selected bare calls from the normalized SSE event array.
    - Correction: froze separate canonical `toolCalls[]` and `mcpCalls[]`
      semantic projections and moved all call/correlation selectors to them.
11. Chat-backed Responses cases expected adapter `done` instead of the
    client-visible `completed` terminal, and parallel-tool counting still used
    nonexistent `tool_call` SSE events.
    - Correction: those terminals now expect `completed`; parallel count/order
      derive from `/client/response/toolCalls`, and `toolCalls`/`mcpCalls` are
      part of the closed observation schema.

### Medium

1. `VERIFIED -> PROBED` was missing after partial invalidation.
   - Correction: added the transition for remaining partial coverage.
2. Scenario and suite freshness authorities conflicted.
   - Correction: effective age is the minimum finite scenario, suite, and
     profile bound.
3. Compatibility-version file hashing and dirty/missing/symlink behavior were
   underspecified.
   - Correction: froze the canonical object, file set, raw-byte hashes, sort
     order, current-working-tree behavior, and fail-closed cases.
4. Sidecar network wording incorrectly put route-local endpoints in scenario
   manifests.
   - Correction: manifests authorize only dependency roles/protocol classes;
     the composite subject owns exact destination fingerprints.
5. The MCP exact-bound vector was not actually at its stated boundary.
   - Correction: replaced it with exact 64-byte and 65-byte UTF-8 JSON schema
     payloads and a recomputed fixture digest.
6. The vision modality control could have made a compatible suite
   `UNSUPPORTED`.
   - Correction: made it a `negative_control`; its exact rejection satisfies
     the suite without projecting route-level `UNSUPPORTED`.
7. The compaction assertion tested presence rather than truth.
   - Correction: changed it to exact equality with `true`.
8. One result-content description claimed call correlation absent from its
   assertions.
   - Correction: removed the claim.
9. Environmental failure effects, claim supersession/currentness, and
   custom-header fingerprint ownership were not mechanically closed.
   - Correction: added the exhaustive class/effect matrix, formal
     `claim_snapshot`/`supersedes[]` schema and currentness algorithm, and a
     config-owner broker that exposes only a domain-separated header digest.
10. `ProtocolSubjectV1` named a second `runtimeFingerprint` without a schema.
    - Correction: removed it; the closed `runtime.*` behavior keys are the sole
      platform-sensitive identity inputs.

### Low

- Corrected the provider-test description: forward/static providers do not
  always perform a live `/models` request.
- Corrected historical reference `#745` from issue to pull request.
- Added `021`/`022` to the stack ledger and created this review record, closing
  all local document links.
- Corrected request-history evidence from “immutable” to canonical
  append-only, limited the profile claim to compatibility policy, and noted the
  explicit state-mutating `ocx doctor --fix-codex-runtime` mode.

## CodeRabbit re-review remediation

All ten unresolved CodeRabbit threads visible on PR #1286 were inspected against
current branch code/contracts before editing. The valid findings were resolved
as follows:

1. Stack audit metadata used a non-SHA dependency label where an exact CL-01
   base revision is required. The stack ledger is refreshed after this review
   with exact base/head fields and the CL-01 correction requirement.
2. `BehaviorFingerprintV1` did not define deterministic ordering for every
   array-valued closed key. V1 now classifies each allowed array as `set` or
   `ordered`, defines JCS-byte sorting/deduplication for sets, preserves source
   order for ordered arrays, and fails closed for any undeclared array input.
3. `all-applicable-required-pass-v1` admitted a vacuous `VERIFIED` result when
   zero required scenarios applied. Positive executable verdicts now require a
   non-empty applicable required set; zero-applicable falls through to current
   claim/unknown semantics, while attempted environmental blockers remain
   `BLOCKED`.
4. `[DONE]` handling was selected by the client-facing surface even for a Chat
   upstream response fixture. Sentinel interpretation now follows the protocol
   of the byte stream being normalized: an `upstream_response` uses its single
   resolved upstream protocol, and only OpenAI Chat recognizes exact `[DONE]`.
5. Two Chat-backed tool-result assertions incorrectly selected Responses
   `input[].call_id`. Production `openai-chat` emits the continuation as
   `messages[1].tool_call_id`; both canonical selectors now assert that actual
   Chat wire shape.
6. Live-probe destination authorization could drift between endpoint
   fingerprinting, credential binding and connect. The security contract now
   requires one immutable per-run `LabDestinationV1` snapshot for every stage
   and fails closed before credential transmission on mutation/re-resolution or
   mismatch.
7. Ambient environment/proxy handling was not executable enough. The V1
   inherited-environment allowlist is empty; the runner constructs only
   `TZ=UTC` and `NO_COLOR=1`, rejects uppercase and lowercase proxy variables,
   and cannot derive behavior from ambient variables.
8. Custom-header fingerprinting lacked resource/canonicalization bounds. The
   broker now enforces entry, duplicate-value, field-name, per-value and
   aggregate byte ceilings before JCS/HMAC, with unknown credential
   classification or overflow failing closed.
9. Ordinary invalidation wording allowed deletion of shared contract artifacts.
   Only event-private non-contract artifacts may be deleted after invalidation;
   shared scenario/suite/fixture artifacts survive until no non-invalidated
   observation references them.
10. Security acceptance coverage omitted the new invariants. Required tests now
    cover environment/proxy denial, destination snapshot mutation/address drift,
    custom-header canonicalization and bounds, subject-salt rotation, and
    retention expiry/cleanup/unavailable markers.

These corrections remain CL-00 contracts only. No CL-02 implementation or
runtime live-probe feature was started.

## Mechanical review evidence

- `022_protocol_v1_cases.json` parses as JSON.
- 35 unique cases cover all required members of the eight initial suites.
- 46 fixture artifacts are present: 35 primary vectors and 11 initiating
  requests.
- Every fixture digest matches
  `sha256("ocx-lab:fixture:v1\0" || UTF8(bytesUtf8))`.
- Every response fixture has one initiating request.
- The MCP bound vector is exactly 64/65 UTF-8 bytes.
- All named verifier selectors have one closed deterministic definition.
- `vision-core.protocol.modality-gate` is the sole V1 negative control and is
  represented as such in case and suite expansion.
- Base failure rules contain no control effect; the vision case alone expands
  the conformance-control rule.
- The two corrected Chat continuation selectors target
  `/upstream/requests/1/json/messages/1/tool_call_id`, matching the current
  `openai-chat` request builder's assistant-call then tool-result message order.
- The selector-only `022` correction did not change any fixture bytes or fixture
  digest; it changes expanded scenario/suite manifest digests as expected for
  the corrected pre-release V1 authority.

## Repository verification

Initial acceptance verification:

- `bun run typecheck`: passed.
- `bun run privacy:scan`: passed.
- `bun test tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
- Focused protocol/compatibility suite excluding Windows privileged-symlink
  state cases: 395 passed, 0 failed across 24 files.
- Focused continuation-state semantics: 2 passed, 95 filtered, 0 failed.
- Serial isolation of failures observed in the full run:
  - `tests/codex-models-cache-invalidate.test.ts`: 6 passed, 0 failed.
  - `tests/codex-native-residue.test.ts`: 63 passed, 2 platform skips,
    0 failed.
- Local link validation, canonical case/digest validation, and
  `git diff --check`: passed.

The current CodeRabbit remediation is documentation/contract-only. Final branch
CI/status and the refreshed unresolved-thread set are checked after the status
ledger sync; this record must not be read as claiming a new full local Bun test
run from the connector environment.

The earlier full `bun run test` result was **not green**. On Windows with Bun
1.3.14 it exited 3 after a cache-invalidation failure, an empty effective-account
lookup, and a Bun `index out of bounds` panic. A broader focused run separately
found four `responses-state.test.ts` failures, all Windows `EPERM` errors
creating symlinks (488 passed, 4 failed). The isolated cache/native tests and
the non-privileged protocol suite passed; this review does not claim the full
suite passed.

## Required challenge results

1. Protocol conformance, live compatibility, and task effectiveness are
   separated: **PASS**.
2. Environmental failures cannot poison compatibility verdicts: **PASS**.
3. `VERIFIED` is reproducible from immutable evidence and cannot be vacuous:
   **PASS**.
4. Exact route identity prevents false evidence reuse: **PASS**.
5. Routing Profiles remain the sole compatibility-policy surface: **PASS**.
6. The Lab cannot become a second router: **PASS**.
7. The Lab cannot become a second provider registry: **PASS**.
8. Probes cannot access user data or arbitrary tools, and live destinations,
   environment and custom-header fingerprints are fail-closed: **PASS**.
9. Historical incidents are representable as deterministic versioned
   scenarios: **PASS**.
10. CL-01 remains implementable without semantic invention after synchronizing
    the corrected V1 authority: **PASS WITH REQUIRED CL-01 CORRECTION**.

## CL-01 impact

The independently accepted CL-01 branch exists at
`feat/cl-01-conformance-harness` and was built on an earlier CL-00 contract tip.
Its acceptance record explicitly documents a harness-only projection of
Chat-wire `messages` tool rows into a synthetic Responses-shaped `input[]` to
satisfy the old CL-00 selectors. That workaround is no longer authoritative:
CL-00 now selects the actual Chat wire `messages[].tool_call_id` field.

Before CL-01 is stacked or merged it must therefore:

- rebase onto the refreshed CL-00 accepted contract head;
- synchronize its copied `protocol-v1-cases.json` authority with the two new
  Chat selectors;
- remove or narrow the synthetic Chat-to-Responses `input[]` observation
  projection so the asserted upstream JSON remains the actual Chat request;
- align the harness SSE-normalizer contract with source-protocol sentinel
  selection (current Chat upstream execution already goes through the
  production Chat parser, but the helper/API contract must not retain the stale
  client-surface rule); and
- rerun the 24 canonical CL-01 scenarios, negative controls, digest/manifest
  checks and its acceptance review.

This CL-00 remediation does not modify CL-01 and does not start CL-02.

## Verdict

No validated unresolved Critical, High, Medium, deterministic-contract, or
security-contract finding remains in the CL-00 contract set after the
CodeRabbit remediation above, subject to the final GitHub thread/CI re-check.

**CL-00: ACCEPTED AFTER CODERABBIT REMEDIATION**
