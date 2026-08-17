# 010 — Phase 1: fail an unlabeled EOF that truncates a tool call

Answers **F1** (`003`). Severity High. One PABCD cycle.
**Revised after an adversarial audit returned FAIL** (findings 3, 4, 5); the
original plan is corrected below rather than defended.

## Problem restated

`live-transport.ts:1029` settles gracefully whenever the HTTP/2 stream ends with
at least one complete frame, without asking whether a terminal was ever emitted.
When a client tool call is still open, its buffered arguments are discarded and
nothing about the call reaches the bridge — the call simply never happened as far
as Codex can tell.

## What `state.terminated` actually means (audit correction)

The original plan called it "a real `turnEnded` arrived". That is **wrong**.
`finalizeTurnEvents` sets it, and two paths call it: the real `turnEnded` update
(`protobuf-events.ts:1327`) and the synthetic client-tool finalize
(`finalizeAfterDrain`, `live-transport.ts:386`, armed at `:750`) that ends the
turn so the Responses bridge can own the client tool.

That does not invalidate the check — it corrects its meaning. The predicate we
need is **"was a terminal already emitted downstream?"**, and `state.terminated`
is exactly that for both paths. The doc, not the code, was wrong.

## An emitted error is also a terminal (round 4 blocker)

Round 4 found the predicate above is still insufficient. `recordToolCall` can emit
an error — unknown tool (`protobuf-events.ts:1103`) or tool-call limit exceeded
(`:1107`) — **without** setting `state.terminated`, and while EARLIER calls stay
open. `tests/cursor-protobuf-events.test.ts:534` pins exactly that: after the
limit error, `openToolCalls.size` is still 2.

That error already reached the bridge as `response.failed`. If the EOF branch
then sees open calls and no `terminated`, it rejects, and `cursor.ts:180` emits a
**second** terminal error for a turn that already failed — the same double-terminal
defect round 2 caught in a different disguise.

**Fix: track downstream terminality explicitly.** The condition for failing at EOF
is "no terminal of ANY kind has been emitted downstream", which is broader than
`state.terminated`. Record an emitted-error flag on the transport (or extend the
event state to mark itself terminal when it emits an `error`), and require:

```
!expectedClose && !state.terminated && !emittedTerminalError && openToolCalls.size > 0
```

Setting `state.terminated` inside the error paths of `recordToolCall` is the
smaller change, but it overloads a field other code reads; prefer the explicit flag
unless implementation shows otherwise. Decide in B, and record which was chosen.
## Single terminal owner (audit correction)

The original plan wanted to call `finalizeTurnEvents` at EOF *and* `settleFail`.
That is incoherent: with no open call the finalizer returns `done`
(`protobuf-events.ts:1376`), so we would emit success and then fail the
transport; with an open call the adapter would emit its error and then the
`catch` at `cursor.ts:180` would emit a second one.

**The transport owns this terminal.** At EOF the adapter does not call the
finalizer at all. It fails with one typed error that carries the open call ids,
and `cursor.ts:180` turns that into exactly one `error` event. `protobuf-events.ts`
is not modified by this phase.

## Scope: the open-tool-call case only

Two sub-cases exist at an unlabeled EOF:

| Sub-case | Decision |
|----------|----------|
| Open tool call(s) at EOF | **Fail.** Arguments are provably lost; a turn that silently drops a tool call is the reported symptom. |
| No open call | **Leave as is** for now. Streaming already reports `response.incomplete` / `adapter_eof` (`bridge.ts:1283`). |

The second row is deliberately out of scope. Non-streaming does default a
terminal-less turn to `"completed"` (`bridge.ts:1829`), which is wrong, but
fixing it requires evidence about whether Cursor ever legitimately ends a stream
without `turnEnded` — and getting that wrong would fail healthy turns. It is
recorded in `000_index.md` as an open follow-up, not smuggled into this phase.

## Retry: claim withdrawn (audit correction)

The original plan claimed a typed error would make the truncated turn retryable.
**False.** `this.committed = true` is set on the HTTP/2 `connect` event
(`live-transport.ts:780`), and any EOF that delivered a response frame is
necessarily post-connect, so `requestUncommitted(transport)` is already false and
`canRetry` cannot be true (`transport-retry.ts:99`). The commitment flag is
correct — bytes reached the server, so replay could duplicate a side effect. No
retry test belongs in this phase, and the guard stays untouched.

## Diff-level plan

**`src/adapters/cursor/cursor-errors.ts`**

- Add `CursorStreamTruncatedError` following the file's existing error
  conventions, carrying the open call ids and the frame count.
- Do **not** classify it retryable: commitment already forbids replay.

**`src/adapters/cursor/live-transport.ts`**

- In the `end` handler's drain-then-classify block, before the final
  `settler.settleFinish()`, add one branch: when `!this.expectedClose`, no
  terminal has been emitted (`!state.terminated`), and the event state has open
  tool calls, `releaseBacklogLease()` then `settler.settleFail(new
  CursorStreamTruncatedError(...))`.
- Everything else in that block is unchanged, including both existing
  `expectedClose` exemptions.

## Tests (`tests/cursor-eof-terminal.test.ts`)

Each must fail before the change and pass after:

1. EOF after >=1 frame with an open tool call and no terminal -> run rejects with
   `CursorStreamTruncatedError` naming the open call id.
2. EOF after a real `turnEnded` -> still graceful, still emits `done`.
3. EOF during `expectedClose` with an open call -> still graceful. Fixture note
   (round 4 finding 2): normal synthetic suspension finalizes with an EMPTY call
   set, which is test 4. To get `expectedClose` together with a surviving open
   call, construct it through an error-triggered cancellation with an open sibling.
4. EOF after the synthetic client-tool finalize (`state.terminated` set, no
   `turnEnded`) -> still graceful. Directly guards audit finding 5.
5. EOF after >=1 frame with **no** open call -> unchanged graceful finish,
   pinning the deliberate scope boundary above.
6. **Mapper error + surviving open call + EOF** -> exactly ONE terminal error
   reaches the bridge, not two. Regression guard for the round 4 blocker; build it
   on the fixture at `tests/cursor-protobuf-events.test.ts:534`.

## Done when

All six pass, `bun run typecheck` clean, cursor suite green on `ssh lidge`,
pushed. Evidence: exact command, output tail, pushed SHA.

