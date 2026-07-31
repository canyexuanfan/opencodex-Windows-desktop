# Phase 100 — Darwin explicit eager-relay opt-in (wp5)

Design base: `052_single_reader_gap.md` §Risk table + §Recommended migration
order step 2. Depends on 090 (the failed tail must exist before Darwin
opt-in traffic can reach the eager path). Targets
`src/server/responses/core.ts` gate + `src/lib/bun-stream-caps.ts` docs
comment; `MIN_FIXED_BUN_VERSION` stays null.

wp5 A-gate corrections (post-wp3/wp4 tree, HEAD 316497fca):

- Gate anchors: `core.ts:1617` (winNoClientRewrite), decision `:1619-1621`,
  stale eager-branch comment `:1672`; `decideEagerRelay`
  `bun-stream-caps.ts:78`; management field `system-routes.ts:85`; native
  marker `relay.ts:372`.
- `selectEagerPath` lives in `bun-stream-caps.ts` (both core.ts and
  system-routes.ts consume the same policy) and returns the normalized
  effective decision `EagerRelayDecision | null` (retain `reason`, force
  `useEagerRelay: false` where darwin policy rejects auto) — not a bare
  boolean.
- The eager WeakSet marker lives beside the native marker in `relay.ts`.
  `withCors` re-wraps the Response (auth-cors.ts:143), so the marker test is
  a DIRECT `handleResponses` integration test, not a network e2e. Reuse
  `mockSseUpstream` + `postSpawn` from
  `tests/subagent-fallback-handle-responses.test.ts:149` (legacy/eager
  exercise at :860; process.platform override pattern at :892 — the "not
  mockable" rationale below is corrected: override works, pure extraction is
  still preferred for clarity).
- Additional platform-policy surfaces IN SCOPE for wp5 (stale after darwin
  opt-in): `src/types.ts:594` streamMode doc comment (windows-only phrasing),
  `config-routes.ts:194` + `tests/settings-stream-mode.test.ts:159`
  (windows-only escape-hatch copy), `tests/doctor.test.ts:411` (darwin
  eagerRelay null fixture),
  `docs-site/.../troubleshooting/windows-memory.md:93` ("auto lets the
  runtime gate decide" — must state darwin auto stays tee; docs commit may
  land in wp6 but the EN source edit belongs to this phase).
- `tests/passthrough-abort.test.ts:34` source-lock reads a mirrored COMMENT
  in `src/server/index.ts:231-247`, not runtime code. wp5 must repoint that
  assertion at the real gate in `core.ts` (or retire the superseded
  assertions in favor of the selector matrix + handler integration test).

## Change

At `core.ts:1617-1621` (current):

```ts
const winNoClientRewrite = process.platform === "win32" && !needsClientRewrite;
const eagerDecision = winNoClientRewrite ? decideEagerRelay(config.streamMode ?? "auto") : null;
```

becomes (shape, exact code in B):

```ts
const noClientRewrite = !needsClientRewrite;
const platformEager = process.platform === "win32"
  || process.platform === "darwin";
const eagerDecision = platformEager && noClientRewrite
  ? decideEagerRelay(config.streamMode ?? "auto")
  : null;
const useEager = eagerDecision?.useEagerRelay === true
  && (process.platform === "win32" || eagerDecision.reason === "config-eager");
```

- win32 semantics are UNCHANGED (auto flips when `MIN_FIXED_BUN_VERSION` is
  eventually set; explicit modes as today).
- darwin reaches eager ONLY via `reason === "config-eager"` (explicit
  `streamMode: "eager-relay"` in config). `auto` on darwin stays tee even
  after a future `MIN_FIXED_BUN_VERSION` bump — flipping darwin auto is a
  separate decision requiring the macOS abort-stress proof (052 step 3/7) and
  is out of scope here (UNSAFE boundary in the goalplan).
- The comment block above the gate is updated to describe the two-platform
  policy and cite this unit.

## wp5 A-gate freshness corrections (consolidated)

1. **All win32-only invariant surfaces must move together:** the in-branch
   comment `core.ts:1672` ("reachable only through winNoClientRewrite") and
   the mirrored comment block in `src/server/index.ts:231-247` are prose,
   not runtime code — update both for accuracy, but the source-lock test
   `tests/passthrough-abort.test.ts:34` must be REPOINTED at the real gate
   in `core.ts` (or its superseded assertions retired in favor of the
   selector matrix + handler integration test). A lock that reads a mirrored
   comment can go green while the real gate is wrong.
2. **`/api/system/memory.eagerRelay` contract:** the field becomes the
   EFFECTIVE platform decision — computed through the same `selectEagerPath`
   predicate the gate uses (normalized `useEagerRelay`, `reason` retained) —
   NOT a naive platform-widened `decideEagerRelay` call, so darwin `auto`
   can never report `useEagerRelay:true` while the gate keeps it on tee.
   The host-sensitive assertion in `tests/memory-watchdog.test.ts:213` is
   updated accordingly.
3. Locations per the same audit: selector tests in
   `tests/bun-stream-caps.test.ts`; eager WeakSet marker beside the native
   marker in `relay.ts`; abort-stress watchdog + child under `scripts/`
   (a crashing probe under `tests/` cannot satisfy the external-watchdog
   requirement), darwin-only integration assertion under `tests/`.

## Abort-stress gate (audit round 1 blocker 7 — BLOCKS this phase's landing)

Before the opt-in commit is considered done, run a bounded local Darwin
abort-stress probe on THIS machine (darwin arm64, Bun 1.3.14 — the exact
at-risk runtime). Topology requirements (R2-4 — an isolated stream-only
`bun test` with `reader.cancel()` does NOT exercise the #32111 boundary and
is insufficient):

- A real `Bun.serve` server returning the ACTUAL `relaySseEagerBounded`
  stream (not a look-alike) as an HTTP `Response` body (the
  JS-stream→native-sink boundary #32111 concerns).
- Real network clients (TCP/fetch with socket abort) issuing ≥200 aborts
  total with a MINIMUM PER CLASS (≥50 each): before first byte, mid-frame,
  during a backpressure pause. Child/parent synchronization must PROVE each
  class was reached (child reports phase markers; parent asserts per-class
  counts).
- Deterministic PRNG (named algorithm, e.g. mulberry32) with the seed
  recorded in this doc; a rerun with the same seed reproduces the schedule.
- The server runs as a CHILD process under an external watchdog (parent
  script) with an overall deadline; the parent distinguishes clean
  completion / expected teardown / signal-crash exit / timeout as separate
  outcomes.

Crash/hang/segfault ⇒ phase outcome BLOCKED: the gate change does not land,
the finding is documented here with the repro + seed, and wp6 proceeds
without wp5. Clean pass ⇒ record the run output (seed, abort count, duration,
exit code) in this doc. This is an opt-in safety probe, not a
Bun-1.3.14-is-safe claim.

### Gate execution record (2026-08-01, main session)

- Run 1 (55 s default deadline): `outcome FAIL classification timeout` at
  124/201 verified aborts — a DEADLINE artifact, not a crash (child was
  healthy, SIGKILL came from the parent watchdog at the deadline). The
  default deadline was raised to 240 s.
- Run 2 (final): `bun scripts/darwin-eager-abort-stress.ts --seed 260801` →
  `{"outcome":"PASS","classification":"clean","seed":260801,
  "requestedTotal":201,"verifiedTotal":201,"verifiedByClass":
  {"before-first-byte":67,"mid-frame":67,"during-backpressure":67},
  "durationMs":114690,"workloadOutcome":"clean-completion",
  "childOutcome":"expected-teardown","childExitCode":0,"childSignal":null,
  "bunVersion":"1.3.14","platform":"darwin","arch":"arm64"}` — no crash, no
  hang, child exited 0 after expected teardown. Gate PASSED; the opt-in
  lands. Still not a Bun-1.3.14-is-safe claim.

## Not changed

- Rewrite traffic (image-gen aliases / item-id repair) stays on tee on both
  platforms (`needsClientRewrite` guard intact).
- `decideEagerRelay` itself unchanged — the darwin restriction lives at the
  call site because it is platform policy, not runtime capability.
- Linux unchanged (no opt-in until asked; smallest honest scope).

## Regression tests (`tests/` near existing stream-caps/core gate tests)

Extract the `useEager` predicate into a pure function
`selectEagerPath(platform, needsClientRewrite, decision)` in
`bun-stream-caps.ts` (shared owner — both `core.ts` and `system-routes.ts`
consume it; returns the normalized `EagerRelayDecision | null`, not a bare
boolean). Platform IS overridable in-process
(`subagent-fallback-handle-responses.test.ts:892` pattern) — the pure
extraction is preferred for clarity, not necessity. Test matrix:

1. win32 + no-rewrite + config-eager → eager (unchanged).
2. win32 + no-rewrite + auto/known-bad → tee (unchanged).
3. darwin + no-rewrite + config-eager → eager (NEW).
4. darwin + no-rewrite + auto (even with minFixed satisfied) → tee.
5. darwin + rewrite + config-eager → tee.
6. linux + anything → tee.

Plus one DIRECT `handleResponses` integration test gated to darwin only
(`test.skipIf` on other platforms; linux must stay tee — audit blocker 8b;
NOT a network e2e: `withCors` re-wraps the Response and loses WeakSet
identity, auth-cors.ts:143): with `streamMode: "eager-relay"` and a
no-rewrite provider fixture (`mockSseUpstream` + `postSpawn` from
`subagent-fallback-handle-responses.test.ts:149`), the passthrough response
takes the eager path. Assertion seam (R2-5 — the native-passthrough marker is
set by BOTH branches and cannot distinguish them): add a path-specific
WeakSet marker `markEagerRelaySseResponse` set ONLY on the eager branch, with
a test-only export `isEagerRelaySseResponse`; the integration test asserts
that marker, and a companion assertion proves the legacy-tee fixture does NOT
carry it. Additionally, `system-routes.ts` computes the `/api/system/memory`
`eagerRelay` field through `selectEagerPath` (effective decision, per
correction 2 above), with its own small test.

## Commit

`feat(stream): let macOS opt in to the eager single-reader relay`

## Abort-stress gate execution record (2026-08-01, wp5)

Probe: `scripts/darwin-eager-abort-stress.ts` (parent watchdog) +
`scripts/darwin-eager-abort-stress-child.ts` (Bun.serve serving the ACTUAL
`relaySseEagerBounded` stream). Host: darwin arm64, Bun 1.3.14.

Result: **PASS / clean.** `seed=260801`, `algorithm=mulberry32`,
`requestedTotal=201`, `verifiedTotal=201`,
`verifiedByClass={before-first-byte:67, mid-frame:67, during-backpressure:67}`
(every abort phase-marker-verified by the child), `durationMs=117876`,
`workloadOutcome=clean-completion`, `childOutcome=expected-teardown`,
`childExitCode=0`, `childSignal=null`. Parent exit 0.

Measured runtime note (recorded in the child source): on darwin Bun 1.3.14
the native Response sink pulls a JS ReadableStream without pacing — an unread
client still drains the upstream — so a parked producer is not reachable over
HTTP on this runtime. The `during-backpressure` class therefore proves "abort
during native-sink buffering with the queue bound exceeded" (≥1 MiB
delivered, unread client), which is the Bun#32111-relevant load state.

This is an opt-in safety probe result, not a Bun-1.3.14-is-safe claim; the
`auto` posture on darwin is unchanged (tee).
## wp5 C-review round 1 synthesis (reviewer Mendel, FAIL 3)

| # | Finding | Decision | Fix |
|---|---|---|---|
| C1-1 High | Probe counts an abort even if it never reached the server (settleExpectedAbort swallows both outcomes; child onClientCancel emits nothing) | ACCEPT | Child emits a per-request server-side teardown ack (`cancel-ack:<id>` covering onClientCancel OR relay teardown); parent counts a verified abort only after receiving it. |
| C1-2 High | during-backpressure marker fires on 1 MiB produced, not on an actual producer pause; darwin native sink drains eagerly so the class can green without backpressure | ACCEPT | Child observes the REAL pause: inject a small maxQueueBytes via relaySseEagerBounded opts in the child and emit the phase marker only when the producer is actually parked (wake-gate instrumentation), or — if the darwin sink genuinely never applies receive backpressure — the class must detect that and report `backpressure-unreachable` honestly instead of green. Chunk-size comment corrected. |
| C1-3 Med | selectEagerPath returns {useEagerRelay, decision} instead of the A-gate contract (normalized EagerRelayDecision \| null); core and system-routes consume different fields | ACCEPT | Return the normalized decision (useEagerRelay already folded in) or null; core tests decision?.useEagerRelay; single source of truth. |
| Hygiene | Two conflicting probe-run records (114690 vs 117876) — the worker ran the probe despite instructions and recorded its own run | ACCEPT | Collapse to ONE record for the final post-fix gate run; earlier runs listed as history with provenance. Probe must be re-run after C1-1/C1-2 fixes anyway — the recorded PASS does not satisfy the gate as written. |
