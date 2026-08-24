# 090 — wp9: #2472, a real regression for silent zero-output tool results

Phase: wp9. Depends on: wp1 only. Independent of wp3–wp7. Must reach a terminal
outcome before wp8 freeze.

> This phase exists because the second audit round found the train had made an
> automated #2472 regression a mandatory GO gate while assigning no phase to
> write it. A gate nobody implements is not a gate.

## The defect as reported

A tool call returns success with no output at all — no stdout, no stderr, no
exit code — and the turn continues as though the command had run. The reporter's
proxy was on a pre-fix binary, which is why the original plan's first instinct
was "restart and re-measure."

## Why the original 100-call canary was the wrong instrument

Three findings, all verified:

1. The process on :10100 is PID 922, started 2026-08-23 — the **stale process
   from the bug report**, not a candidate build. Measuring it proves nothing
   about the code this train is assembling.
2. The failure needs Cursor native-shell/host-shell interleaving with duplicate
   call ids. Duplicates are already dropped at
   `src/adapters/cursor/protobuf-events.ts:1055`, and the two execution paths
   stay separate at `src/adapters/cursor/live-transport.ts:1445`. An ordinary
   prompt cannot deterministically produce that interleaving, so "100 calls,
   0 empty results" is a statement about luck.
3. It would restart the user's live proxy and spend real provider credits to
   produce that non-evidence.

## What this phase does instead

Drive the interleaving directly, in-process, with no provider spend.

`tests/cursor-zero-output-failover.test.ts` — **NEW**:

1. `interleaved native and host shell results with duplicate call ids do not
   silently succeed` — feed the event stream a native-shell result and a
   host-shell result carrying the **same** call id, in both orders. Assert the
   turn ends with either a typed error or a combo failover, never a success
   carrying zero semantic output.
2. `a turn that ends with zero semantic output is not reported as success` —
   construct `turnEnded` with no text, no tool output, and no reasoning. Assert
   the runtime classifies it as a typed failure rather than an empty success.
3. `duplicate-drop does not consume the only surviving result` — the drop at
   `protobuf-events.ts:1055` must not be the reason output disappears; assert
   the retained result is the one that reaches the turn.

Each test must be observed **failing against current `dev`** before any fix, or
observed passing with a recorded explanation of why the behavior is already
correct. A green test that was never red proves only that it was written after
the behavior.

## Terminal outcomes

- **Reproduced** → #2472 becomes a release blocker; the fix is a new work-phase
  appended to the goalplan, not a patch smuggled into another phase.
- **Not reproduced, tests green** → the primary zero-output defect is closed by
  the failover fix already on `dev`; #2472 is closed with the test as evidence,
  and the incorrect `wall_time_seconds` reporting is split into its own
  telemetry issue.
- **Cannot be driven deterministically in-process** → record exactly which
  interleaving could not be constructed and why, deregister #2472 as a GO
  criterion (per 000), and file it as a deferred known defect with the finding
  attached.

All three are acceptable closes. Silence is not.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | The regression file exists and runs | `bun test tests/cursor-zero-output-failover.test.ts` |
| 2 | Each test was observed red-then-green, or its green start is explained | captured output in the D record |
| 3 | A terminal outcome from the three above is recorded | this doc, updated at close |
| 4 | If deferred, 000's GO criteria are amended to match | 000 diff |

## Scope boundary

IN: the new test file and, if the defect reproduces, a recorded decision about
where the fix goes.
OUT: implementing that fix inside this phase; restarting or reconfiguring the
user's running proxy; any live provider call.

