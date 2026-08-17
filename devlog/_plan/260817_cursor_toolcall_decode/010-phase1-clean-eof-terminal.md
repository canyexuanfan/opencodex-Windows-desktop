# 010 — Phase 1: gate the clean-EOF terminal

Answers **F1** (`003`). Severity High. One PABCD cycle.

## Problem restated

`live-transport.ts:1029` settles gracefully whenever the HTTP/2 stream ends with
at least one complete frame, regardless of whether Cursor ever sent the
application-level `turnEnded`. The fail-closed open-tool-call check that already
exists (`protobuf-events.ts:1361`) is therefore skipped exactly when it is
needed, and non-streaming callers see `status: "completed"` on a truncated turn
(`bridge.ts:1829`).

## Contract to establish

A Cursor turn may only settle successfully when the application says it ended.
Concretely, at the `end` handler, after the existing leftover-bytes and
zero-frame checks:

1. If `state.terminated` is true — a real `turnEnded` was processed — settle
   gracefully. Unchanged behavior.
2. If `this.expectedClose` is true — we intentionally suspended the stream to run
   a client tool — settle gracefully. Unchanged behavior; this path is how a
   normal Responses-owned tool call works (`:737`, `:806`).
3. Otherwise the stream ended without application termination. Run the same
   finalization the `turnEnded` path runs, so open calls produce the existing
   explicit truncation error, and settle **fail** with a typed error.

Point 3 is the whole change. It routes an unlabeled EOF into machinery that
already exists rather than inventing new reporting.

## Why fail rather than emit `done`

Emitting `done` would assert the model finished its turn, which is precisely the
claim we cannot support. A typed failure is also what makes the retry guard
reachable: today a clean EOF throws nothing, so `transport-retry.ts:97` returns
success without ever evaluating `canRetry`. With a thrown typed error, a turn
that emitted nothing downstream (`!emittedAny`) and is still uncommitted becomes
retryable — turning a dead turn into a transparent retry. The guard itself must
not be loosened; replay after partial emission would duplicate output.

## Diff-level plan

**`src/adapters/cursor/live-transport.ts`**

- In the `end` handler's drain-then-classify block, after the `framesReceived === 0`
  branch, add the termination check before `settler.settleFinish()`:
  - allow graceful finish when `this.expectedClose` or the event state reports
    terminated;
  - otherwise `releaseBacklogLease()`, then `settler.settleFail(...)` with a new
    typed error carrying the frame count and any open tool-call ids.
- The event state is already reachable from the transport for finalization; if it
  is not, thread the existing state reference rather than duplicating it.

**`src/adapters/cursor/cursor-errors.ts`**

- Add a `CursorStreamTruncatedError` (name it to match existing conventions in
  that file) so the failure is typed, not a bare `Error`.
- Classify it as **retryable** in `isRetryableCursorError` only for the
  no-bytes-emitted case; the `!emittedAny` guard already enforces that, so the
  classification stays simple.

**`src/adapters/cursor/protobuf-events.ts`**

- No behavior change. `finalizeTurnEvents` is reused as-is; if it is not exported
  in a form the transport can call at EOF, export a thin wrapper.

**`src/bridge.ts`** — out of scope for this phase. Once the adapter throws, the
non-streaming `completed` default is no longer reachable via this path. A
defensive change there would be a separate unit with its own evidence.

## Tests (`tests/cursor-live-transport.test.ts`, or a new `cursor-eof-terminal.test.ts`)

Each must fail before the change and pass after:

1. **EOF after frames without `turnEnded`, no open call** -> transport rejects
   with the typed truncation error, not a graceful finish.
2. **EOF after frames with an open tool call** -> the emitted events include the
   existing "incomplete tool call(s)" error naming the call id, and the run fails.
3. **EOF after a real `turnEnded`** -> still settles gracefully, still emits
   `done`. Regression guard for the normal path.
4. **EOF during `expectedClose`** (client-tool suspension) -> still graceful.
   This is the one that would break every working Computer Use turn if the gate
   were written naively, so it is mandatory.
5. **Retry**: a truncated EOF with nothing emitted downstream is retried; one
   with prior emission is not.

## Done when

All five tests pass, `bun run typecheck` is clean, and the cursor-focused suite
passes on `ssh lidge`. Evidence: exact command, output tail, pushed SHA.

