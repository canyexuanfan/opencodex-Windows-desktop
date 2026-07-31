# Phase 100 — Darwin explicit eager-relay opt-in (wp5)

Design base: `052_single_reader_gap.md` §Risk table + §Recommended migration
order step 2. Depends on 090 (the failed tail must exist before Darwin
opt-in traffic can reach the eager path). Targets
`src/server/responses/core.ts` gate + `src/lib/bun-stream-caps.ts` docs
comment; `MIN_FIXED_BUN_VERSION` stays null.

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

## Abort-stress gate (audit round 1 blocker 7 — BLOCKS this phase's landing)

Before the opt-in commit is considered done, run a bounded local Darwin
abort-stress probe on THIS machine (darwin arm64, Bun 1.3.14 — the exact
at-risk runtime). Topology requirements (R2-4 — an isolated stream-only
`bun test` with `reader.cancel()` does NOT exercise the #32111 boundary and
is insufficient):

- A real `Bun.serve` server returning the eager relay stream as an HTTP
  `Response` body (the JS-stream→native-sink boundary #32111 concerns).
- Real network clients (TCP/fetch with socket abort) issuing ≥200 aborts at
  randomized offsets: before first byte, mid-frame, during a backpressure
  pause. Random seed recorded in this doc.
- The server runs as a CHILD process under an external watchdog (parent
  script) so a segfault/hang is observed as child exit-code/timeout, not as a
  vanished test.

Crash/hang/segfault ⇒ phase outcome BLOCKED: the gate change does not land,
the finding is documented here with the repro + seed, and wp6 proceeds
without wp5. Clean pass ⇒ record the run output (seed, abort count, duration,
exit code) in this doc. This is an opt-in safety probe, not a
Bun-1.3.14-is-safe claim.

## Not changed

- Rewrite traffic (image-gen aliases / item-id repair) stays on tee on both
  platforms (`needsClientRewrite` guard intact).
- `decideEagerRelay` itself unchanged — the darwin restriction lives at the
  call site because it is platform policy, not runtime capability.
- Linux unchanged (no opt-in until asked; smallest honest scope).

## Regression tests (`tests/` near existing stream-caps/core gate tests)

Platform is not mockable in-process, so gate logic must be extracted or tested
via the decision helper: extract the `useEager` predicate into a pure function
`selectEagerPath(platform, needsClientRewrite, decision)` in
`bun-stream-caps.ts` (or core-local export) and test:

1. win32 + no-rewrite + config-eager → eager (unchanged).
2. win32 + no-rewrite + auto/known-bad → tee (unchanged).
3. darwin + no-rewrite + config-eager → eager (NEW).
4. darwin + no-rewrite + auto (even with minFixed satisfied) → tee.
5. darwin + rewrite + config-eager → tee.
6. linux + anything → tee.

Plus one end-to-end fixture test gated to darwin only (`test.skipIf` on other
platforms; linux must stay tee — audit blocker 8b): with `streamMode:
"eager-relay"` and a no-rewrite provider fixture, the passthrough response
takes the eager path. Assertion seam (R2-5 — the native-passthrough marker is
set by BOTH branches and cannot distinguish them): add a path-specific
WeakSet marker `markEagerRelaySseResponse` set ONLY on the eager branch, with
a test-only export `isEagerRelaySseResponse`; the e2e test asserts that
marker, and a companion assertion proves the legacy-tee fixture does NOT
carry it. Additionally, `system-routes.ts` makes the `/api/system/memory`
`eagerRelay` field platform-inclusive (populated whenever the eager decision
applies, not only on win32), with its own small test.

## Commit

`feat(stream): let macOS opt in to the eager single-reader relay`
