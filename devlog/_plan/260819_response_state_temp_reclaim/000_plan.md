# 260819 — response-state temp reclaim

## Objective

Abandoned `responses-state.json.ocx.<pid>.<seq>.tmp` files can accumulate without
bound. A field report described ~19.6 GB of these files on one machine. Make the
existing reclaim run on a schedule that does not depend on serving traffic, and give
an operator a way to reclaim them when the proxy will not start at all.

## Evidence (verified against this tree at 59964ad77)

- `src/config.ts:293` — `atomicWriteFileAsync` names its temp
  `${target}.ocx.${process.pid}.${++_atomicSeq}.tmp`. This is the exact reported shape.
- `src/responses/state.ts:26` — `SNAPSHOT_TOTAL_MAX_BYTES` is 24 MiB, and the snapshot
  is rewritten whole on every persist. One abandoned temp is therefore up to 24 MiB,
  which matches the reported 20–27 MB per file.
- `src/responses/state.ts:548` — `recoverStaleResponseStateTemps` already implements
  the reclaim, with a 15-minute age gate, a PID-liveness check, a regular-file check,
  and bounded scan/cleanup counts. **The reclaim logic is correct and is not the defect.**
- `src/responses/state.ts:621` — its ONLY caller is `ensureLoaded()`, which is lazy and
  runs on first continuation access (`state.ts:991`, `:1073`, `:1185`).

## Root cause

The reclaim is attached to the request path. A proxy that crashes before serving a
continuation request leaves its temp behind and never reaches the code that would
reclaim it. The condition that produces the garbage is the same condition that
disables the collector, so the file count only ever grows.

This is a scheduling defect, not a missing-feature defect. Both layers below move or
add a CALLER; neither changes reclaim semantics.

## Scope

IN: caller placement for the existing reclaim; an operator-facing reclaim path.

OUT: the 24 MiB whole-file rewrite. Incremental snapshotting would reduce the blast
radius per failure, but it changes the durability contract of the continuation cache
and is a much larger risk surface. It is recorded here as a known residual, not
silently dropped.

OUT: `src/storage/cleanup.ts` temps (`:1073`, `:2420`). Different owner, different
lifecycle; if they share the defect it is a separate unit.

## Work-phase map (dependency-ordered — PHASE-SPLIT-01)

| # | Phase | Doc | Depends on |
|---|-------|-----|------------|
| 1 | Periodic reclaim via the state-store sweeper | `010_phase1_periodic_sweeper.md` | — |
| 2 | Operator reclaim via `ocx doctor` | `020_phase2_doctor_reclaim.md` | phase 1 |

Phase 1 makes a RUNNING proxy self-healing. Phase 2 covers the case phase 1 cannot
reach — a proxy that will not start — and reuses the reporting shape phase 1
establishes. The dependency runs upward, so the stack lands bottom-up.

## Stack plan (DEV-STACK-01)

Two layers. Phase 1 is mergeable alone and fixes the reported accumulation for every
user whose proxy runs at all; phase 2 builds on it.

```
codex/tmp-reclaim-2-doctor    → PR #2 (base: codex/tmp-reclaim-1-sweeper)
codex/tmp-reclaim-1-sweeper   → PR #1 (base: dev)
```

## Terminal criteria

- A proxy that never serves a continuation request still reclaims abandoned temps.
- An operator whose proxy will not start can reclaim them with a documented command.
- No live temp is ever removed: the age gate and PID-liveness check stay intact.
- `bun run typecheck` and `bun run test` green before either PR is review-ready.
