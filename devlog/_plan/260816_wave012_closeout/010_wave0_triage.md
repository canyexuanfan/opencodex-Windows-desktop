# 010 — Wave 0: triage mutations

No issue is closed in this phase. GitHub metadata only; no repository code.

## Actions

1. `#1802` — add label `bug`. It currently has `cli` only, yet its title and body describe a real regression (`ocx sync` overwriting a hand-edited config from stale server memory). Keeps the release-blocker count honest at 27 rather than 26.
2. `#92`, `#417` — already labelled `upstream-tracking`. No mutation; record in this unit that they are excluded from the release-blocker statistic, and post one short comment on each confirming they remain upstream trackers and are not counted as ocx release blockers.
3. PR `#1822` — `bug` label review. The PR clarifies Log Guard storage UX and adds a write-load poster; that is GUI UX follow-up, not a defect fix. Replace `bug` with `gui`.
4. `#1049` — post a comment linking `#1798` and `#1802` as independent acceptance cases under the write-coordinator umbrella, stating explicitly that closing `#1049` does not close either.

## Evidence

- `gh issue view 1802 --json labels` shows `bug` present afterwards.
- `gh pr view 1822 --json labels` shows `gui`, not `bug`.
- Comment URLs on `#1049`, `#92`, `#417`.

## Non-goals

- Do not close `#92`, `#417`, `#1049`, `#1798`, `#1802`.
- Do not retitle anything.
