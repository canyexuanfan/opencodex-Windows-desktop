# 050 — Fix #843: Antigravity replay fixed-size key identities + transient canonicalization bound

Depends on: 001 root-cause delta. Caps/TTL/sweeper already landed (`034d320b8`); this closes unaccounted key bytes and the transient canonical-JSON allocation.

## File map

- MODIFY `src/adapters/google-antigravity-replay.ts`
  - `replayKey` (:57): SHA-256 hex of `model + "\0" + sessionId` — fixed 64-char outer key regardless of input length.
  - `functionCallKey` (:61/:70): SHA-256 hex of `functionName + "\0" + canonicalArgs` — fixed 64-char call key.
  - Transient bound: pre-check the serialized argument size BEFORE recursive canonicalization (reject typed over the 64 KiB signature budget), or canonicalize incrementally feeding the hash — pick the simpler of the two that preserves the canonical-form equality semantics existing tests rely on.
  - PRESERVE: `ReplayCall.touchedAtMs` LRU, exact deletion accounting, `antigravityReplayRetainedStoreSnapshot`, centralized sweeper registration, shared-budget call, TTL-refresh-on-duplicate-observation (native semantics, recorded decision in 001).
- MODIFY `tests/google-antigravity-replay.test.ts`: new regressions (below).

Scope OUT: TTL value (1h), the existing numeric caps (10,240/256/2 MiB/64 MiB/64 KiB — PR #843's 32 MiB global is SMALLER than native 64 MiB counted; keep native since keys become fixed-size and counted bytes already cover payloads), Claude bypass behavior.

## Acceptance + activation scenarios

1. Enormous model/session identities (e.g. 1 MiB strings): retained store size stays fixed — snapshot `bytes` for such a session reflects only the fixed key + counted payload, not the raw identity strings. Activation: fixture with 1 MiB model + session IDs asserting bounded `replayBytes` (red on pre-fix tree — raw keys are retained).
2. Functional matching unchanged: observe-then-apply with identical calls still replays; nested canonicalization equality preserved. Activation: existing :23 tests stay green (hash mismatch between observe/apply would break these).
3. Delimiter ambiguity impossible: model `"a\0b"` vs model `"a"` + session `"b..."` cannot collide (NUL separators + fixed-length hex). Activation: collision-fixture test.
4. Oversized arguments rejected typed BEFORE canonicalization allocation (if the pre-check shape is chosen). Activation: large-argument fixture with allocation-guard assertion.
5. Eviction still returns exact released bytes (shared-budget eligibility preserved). Activation: existing budget-eviction tests stay green.
6. Red-green: #1 red on the pre-fix tree.

## Regression risks (watch in C)

- Any hashing mismatch between observe and apply breaks replay → upstream signature errors (covered by #2, but watch e2e-style replay tests).
- Do not change duplicate-observation TTL refresh (recorded decision).
