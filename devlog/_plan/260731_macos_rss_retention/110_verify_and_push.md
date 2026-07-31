# Phase 110 — final verification, docs sync, push (wp6)

Terminal gate for the implementation phases 070–100.

## Gates (all must be green, exit codes recorded in this doc at close)

1. `bun run typecheck`
2. `bun run test` — full suite, run as managed background execution with
   polling (CPU-heavy; local contention caveat: if the suite is disturbed by
   parallel work, re-run rather than reporting an interrupted run).
3. `bun run privacy:scan`
4. `git log` — every LANDED phase commit present (wp5's commit only if its
   abort-stress gate passed — R2-6), only this unit's files staged (selective
   staging; `devlog/_plan/260731_client_config_export/` and other concurrent
   dirty files excluded).
5. Phase-local gates completed: 070's post-patch remote smoke calibration
   (no warm-invalid trip) and 100's darwin abort-stress probe (or the
   documented BLOCKED outcome excluding wp5 from the push).

## Docs sync

- docs-site: `streamMode` reference gains the darwin opt-in sentence ONLY if
  wp5 landed (R2-6; a BLOCKED wp5 ships no gate change and no docs sentence).
  En source; locales must not contradict — add the same minimal note or leave
  locales untouched if the page defers to en.
- This unit's docs updated with final evidence (counters payload sample,
  test names, commit hashes).

## Push (explicitly authorized by the user in this session)

1. `git fetch origin && git merge --ff-only origin/dev` (re-sync; if diverged,
   rebase our commits, re-run gates).
2. `git push origin dev`.
3. Verify `git rev-parse dev origin/dev` match; record hashes here.

## Live follow-up (post-push, documented not executed)

- The running proxy (pid 63737 at investigation time) predates the patch;
  after the user restarts/upgrades, `ocx observe memory --json` exposes
  `inspectionCounters` — frame-buffer high-water, item-cap evictions, drain
  stops — for real-traffic attribution without a macmini harness run.
- macmini harness re-run (070's runbook) remains available for controlled
  numbers; the FULL measurement run is not a gate for this unit (the smoke
  calibration in wp2 is). No measured-fix claim is made anywhere in this unit.
