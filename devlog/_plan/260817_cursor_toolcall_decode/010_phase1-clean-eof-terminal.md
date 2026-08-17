# 010 — Phase 1: one terminal per Cursor turn

Answers **F1** (`003`). Severity High. One PABCD cycle.
**Revised three times under adversarial audit** (rounds 2, 4, 5). Round 5 changed
the shape of the phase, not just its details — read the next section first.

## What round 5 changed

Round 4 caught that the planned EOF branch could emit a *second* terminal error
after a mapper error. The fix was to widen the EOF predicate. Round 5 then showed
that widening the EOF predicate **is not enough, because the duplicate-terminal
defect already exists on `dev` without any of my changes**:

- `recordToolCall` / `commitToolCall` emit an `error` without setting
  `state.terminated` (`protobuf-events.ts:1100-1169`).
- A later real `turnEnded` still passes the `if (state.terminated) return []` guard
  (`:1231`), reaches `finalizeTurnEvents` (`:1327`), and emits **another** `error`
  or a `done` (`:1361-1376`).
- Likewise a mapper error followed by a Connect/socket/abort/budget failure:
  the queued error is yielded first (`live-transport.ts:611-623`), then
  `cursor.ts:180` emits the thrown failure as a second terminal.

So the real invariant this phase must establish is broader than the EOF gate:

> **Exactly one terminal event per Cursor turn.**

The clean-EOF gap (F1) is one violation of that invariant. The post-error
`turnEnded` and post-error transport failure are two more, and they are already
shipping. Fixing only F1 would leave the same class of bug live — and would make
this phase's own tests pass while the defect persists next door.

## Contract to establish

1. An emitted terminal (`done` or `error`) makes the turn terminal. Nothing after
   it may emit a second one.
2. An unlabeled EOF that leaves a tool call open is a failure, not a success.
3. A turn that intentionally suspends for a client tool (`expectedClose`) is
   unaffected.

## Where the flag lives (round 5, finding 2)

`CursorTransport` has no downstream-emission backchannel
(`transport.ts:5-14`), so setting a flag from `cursor.ts:127-142` would mean
threading new state through `runCursorTurnWithRetry`. The narrower seam is the
transport's own `push` (`live-transport.ts:531-535`): set a per-run
`emittedTerminal` flag when a `done` or `error` message is admitted to the queue.
Admission guarantees delivery, because the queue is drained before completion or
failure (`:611-623`).

That flag must be consulted in **three** places, not one:

| Site | Behavior when `emittedTerminal` |
|------|-----------------------------------|
| the EOF branch in the `end` handler | do not fail; the turn already ended |
| `handleServerMessage` / `finalizeTurnEvents` dispatch | drop the duplicate terminal |
| `failAndClear` / the throw at `:619` | do not throw a second terminal after one was delivered |

Treating it as EOF-only is the tempting shortcut and the wrong one: it would pass
this phase's tests while leaving the two pre-existing duplicates untouched.

## Diff-level plan

**`src/adapters/cursor/cursor-errors.ts`**

- Add `CursorStreamTruncatedError` following the file's conventions, carrying the
  open call ids and frame count. Not retryable — `committed` is set on HTTP/2
  `connect` (`live-transport.ts:780`), so replay is already forbidden and the
  round-1 retry claim stays withdrawn.

**`src/adapters/cursor/live-transport.ts`**

- Add the per-run `emittedTerminal` flag, set in `push` for `done`/`error`.
- EOF branch: when `!expectedClose && !state.terminated && !emittedTerminal &&
  openToolCalls.size > 0`, `releaseBacklogLease()` then
  `settler.settleFail(new CursorStreamTruncatedError(...))`.
- Suppress a post-terminal duplicate at the message-dispatch site and at the
  failure throw.

**`src/adapters/cursor/protobuf-events.ts`**

- No behavior change if the transport-side flag is sufficient. If suppression is
  cleaner inside the event state, prefer setting a dedicated field over
  overloading `state.terminated`, which other code reads with a different
  meaning. Decide in B and record which was chosen.

**Out of scope:** the non-streaming `completed` default (`bridge.ts:1829`).
Recorded in `000_index.md` as a follow-up.

## Tests (`tests/cursor-eof-terminal.test.ts`)

Fixtures identified by round 5: `withDiscoveryServer`
(`tests/cursor-hardening.test.ts:17-39`), `startedFrame`/`execFrame`
(`tests/cursor-tool-finalize-race.test.ts:20-59`), `turnEndedFrame`
(`tests/cursor-protobuf-events.test.ts:66-71`), `validEmptyFrame`
(`tests/cursor-hardening.test.ts:412-414`), and the tool-limit fixture
(`tests/cursor-protobuf-events.test.ts:510-539`).

1. EOF after >=1 frame with an open call, no terminal -> rejects with
   `CursorStreamTruncatedError` naming the open call id.
2. EOF after a real `turnEnded` -> graceful, emits `done`.
3. EOF during `expectedClose` with a surviving sibling call -> graceful.
   Note (round 5): this fixture necessarily emits an error, so it cannot isolate
   the `expectedClose` conjunct on its own; the flag also suppresses it. Kept as a
   path regression, not as proof of that one term.
4. EOF after the synthetic client-tool finalize -> graceful.
5. EOF after >=1 frame with no open call -> unchanged graceful finish.
6. Mapper error + surviving open call + EOF -> exactly ONE terminal.
7. **Mapper error -> real `turnEnded`** -> exactly ONE terminal. Pre-existing
   defect; must fail on the unmodified tree.
8. **Mapper error -> transport/budget failure** -> exactly ONE terminal.
   Pre-existing defect; must fail on the unmodified tree.

Tests 7 and 8 are the ones that prove this phase fixed a live bug rather than
only a hypothetical one.

## Done when

All eight pass, `bun run typecheck` clean, cursor suite green on `ssh lidge`,
pushed. Tests 7 and 8 must be demonstrated red on the pre-fix tree; a regression
test that never failed proves nothing.

