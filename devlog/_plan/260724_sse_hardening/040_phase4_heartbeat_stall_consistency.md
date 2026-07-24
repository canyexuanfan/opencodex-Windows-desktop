# 040 — Phase 4: Heartbeat / stall consistency (class 11)

One PABCD cycle. Hardening: upstream keepalive must reset the stall clock;
dead heartbeat code must be resolved one way or the other.

## Scope

IN:
- src/lib/sse-decoder.ts (optional comment/activity notification)
- src/adapters/anthropic.ts + src/adapters/google.ts (wire activity ->
  AdapterEvent heartbeat)
- src/bridge.ts (confirm heartbeat resets the adapter-activity clock; fix
  if it does not)
- src/server/relay.ts (relaySseWithHeartbeat dead code resolution)
- tests: sse-decoder, bridge-lifecycle (stall), anthropic/google stream
  suites

OUT: stall-timeout default tuning (300s stays), native passthrough
synthetic heartbeat wire-change (byte-verbatim contract; see decision
below), Cursor/Kiro (already emit heartbeat events).

## File change map

### 1. src/lib/sse-decoder.ts — MODIFY decodeServerSentEvents

Current (verified, :41): comment lines are dropped inside acceptLine.

Change (additive, backward-compatible):
- Extend options: `{ signal?: AbortSignal; onActivity?: () => void }`.
- Invoke `onActivity` for every accepted line INCLUDING comment lines
  (`:`-prefixed) and keepalive blanks — any byte arrival is liveness.
- Callers that pass no onActivity see zero behavior change (anthropic and
  chat/outbound are the current callers).

### 2. src/adapters/anthropic.ts — wire activity

At the decodeServerSentEvents call sites (:717, :740): pass
`onActivity: () => { noteActivity(); }` where noteActivity records a
timestamp; when the adapter's event loop has emitted no real event since
the last activity note, yield `{ type: "heartbeat" }` so the bridge's
adapter-activity clock resets. Simplest correct form: yield heartbeat on
each comment-only record (decoder yields nothing for comments, so emit
heartbeat from onActivity via a pending-flag consumed on next loop turn).

### 3. src/adapters/google.ts — wire activity

After phase 1's scanner remains line-based: treat any non-empty upstream
line that is not a data frame (comments, blanks) as liveness; emit
`{ type: "heartbeat" }` when no content event has been produced by the
current read batch. Keep it cheap: at most one heartbeat per read batch.

### 4. src/bridge.ts — verify heartbeat handling (:196 region)

AdapterEvent heartbeat must reset the same clock the stall timeout uses.
If the bridge currently only uses heartbeat for downstream keepalive,
extend it to also refresh the upstream-activity timestamp. This is a
verify-first item: read, then patch only if missing.

### 5. src/server/relay.ts — relaySseWithHeartbeat (:324)

Zero callers. Decision: REMOVE the dead export (and its tests adjusted),
OR wire it. Native passthrough is byte-verbatim and adding synthetic
comment frames changes wire bytes; the conservative resolution is removal
+ a comment where it was pointing at the stall/keepalive design. If the
A-gate reviewer argues for wiring behind config, amend here before B.

## Accept criteria + activation scenarios

1. Anthropic stream sending only `: keepalive` comments for N seconds
   during reasoning -> bridge receives heartbeat events; no
   upstream_stall_timeout fires while comments flow. Activation:
   bridge-lifecycle test with a comment-only generator and a shortened
   stall budget; assert no incomplete is synthesized.
2. Google comment-only keepalive -> same contract.
3. Truly silent upstream (no bytes at all) -> stall timeout still fires
   (regression pin).
4. sse-decoder tests: existing 42 stay green without onActivity; new test
   proves onActivity fires for comment lines and blank keepalives.
5. `bun run typecheck` green; focused suites green.

## Risks

- Extra heartbeat events are already part of the AdapterEvent contract
  (Cursor/Kiro emit them), so the bridge/downstream tolerate them.
- Removing a dead export is a public-surface no-op (no callers), but the
  A gate must confirm no docs/scripts reference relaySseWithHeartbeat.
