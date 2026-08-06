# 120 — Phase 13: reasoning-replay empty-delta handoff (PR #1126)

Credit: **NexusCore** (`@ZachDreamZ`,
`Agent59353 <email from PR head>`), PR #1126.
Adoption: **adapted** — the bug fix is taken, the persistence feature is not.

## Defect

Replay candidates are lost when a provider emits empty `text_delta` /
`thinking_delta` events, so reasoning replay restarts cannot reconstruct the
turn.

## Why adapted

A real empty-delta bug sits inside a much larger optional feature: persisting
chain-of-thought to disk, shutdown hooks, global counters, and config plumbing.
Writing model reasoning to disk is a privacy-surface change, not a bug fix —
`src/responses/reasoning-replay-cache.ts:17` documents a memory-only contract
deliberately. Changing that contract needs its own decision, not a ride along a
defect repair.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/bridge.ts` | MODIFY | `:826` (streaming) and `:1558` (batch) — preserve replay candidates across empty `text_delta`/`thinking_delta` events |
| `src/responses/reasoning-replay-cache.ts` | KEEP | Memory-only contract at `:17` unchanged |
| `tests/*reasoning-replay*.test.ts` | MODIFY | Empty-delta sequences in both builders; assert nothing is written to disk |

**Dropped:** disk persistence, exit hooks, global warning metrics, and the
associated config surface. Stated in the PR so the contributor can see exactly
what was kept and why.

## Verification

- `bun test` on the reasoning-replay and bridge suites
- `bun run typecheck`
- `bun run privacy:scan` (load-bearing here — it is the gate that would catch a
  reasoning-to-disk regression)

## PR

Stack 12, base = stack 11 head. Credits NexusCore. #950 is already closed by
#971, so no issue link.
