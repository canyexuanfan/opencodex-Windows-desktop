# Phase 070 — harness warm/observation gate fix (wp2)

Consumes the exact diff already written and `git apply --check`-verified in
`050_macmini_run_rca.md` §Proposed harness patch. This doc adds only the
execution and verification contract; the hunks in 050 are the source of truth.

## Change

`scripts/macos-rss-retention-harness.ts` only:

1. `pause(ms)` clamps to a monotonic `performance.now()` deadline and re-sleeps
   on early wake (Bun.sleep can return ~1 ms early; Run 2 failed at 59,999 ms).
2. Warm gate splits child-exit and duration errors, captures `exitCodeAtGate`
   before cleanup, and measures with `performance.now()` (wall time retained as
   a diagnostic field).
3. Observation gate gains the same monotonic duration check; the analysis
   envelope validator consumes `actualMs` instead of wall-clock subtraction.

## Explicitly NOT changed

- No gate is weakened: WARM/OBSERVE minimums stay mandatory, no tolerance is
  added after seeing a result.
- Child files, sampler, and validator thresholds (`sampler gap >1s`) untouched.

## Verification

- `bun run typecheck` green (harness is in the tsc project).
- The harness is an offline instrument, not a test/CI job — no suite impact
  expected; full-suite green is still required before the phase commit lands.
- **Post-patch remote smoke calibration (audit round 1 blocker 6):** after the
  patch lands locally, sync it to `macmini-cf` (`~/rss-measure/opencodex`) and
  run ONE smoke calibration per 050's runbook step 2 (minutes-scale, cheap).
  Gate: calibration passes and no `warm invalid` trip. The smoke summary
  self-stamps `valid:false, smoke:true` BY DESIGN — that stamp is the
  contract working, not a failure. No full measurement run in this phase; no
  measured-fix claim anywhere in this unit.

## Commit

One commit: `fix(rss-harness): clamp pauses to monotonic deadlines and split warm-gate errors`.
