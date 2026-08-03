---
title: FAB-01 Authority or Block
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 170 — FAB-01 Authority or Block

## FAB-01 authority status: NOT AUTHORISED

FAB-01 (read-only Task Inspector) is **not** authorised by this handoff.

## Prerequisites for FAB-01 authority (all required)

1. Independent FAB-00 acceptance (`PASS`) per the acceptance model (`160`).
2. Maintainer decision on language authority (`120` §4): (A) TS-native or (B) a Go migration line.
3. Maintainer decision on product placement (`030` §2): Fabric as a new opencodex subsystem vs. a sibling project.
4. If (A): a new branch off `dev` (not `main`) for the Fabric subsystem; create `AGENTS.md`/`CONTRIBUTING.md` governance (gap in `010` §4).
5. Update master plan §7 to remove the false "Go migration line" premise and record the chosen authority.

## NEEDS_HUMAN flag

Items 2–3 are maintainer-authority decisions FAB-00 cannot make. Until resolved, FAB-01 has no written authority.

## Exact FAB-01 scope (when authorised)

Fabric database + event store + projections + artifact store + Task CLI + read-only Codex importer + usage correlation + Task Inspector dashboard. **No runtime ownership or handoff** (those are FAB-02+). Inherits the contracts from `060`/`070` (protobuf envelope, normalised events, adapter contract) and the persistence/lease model from `090`.

## Statement

`FAB-01 IS NOT AUTHORISED BY THIS HANDOFF ALONE.`
