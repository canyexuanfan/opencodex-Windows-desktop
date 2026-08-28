# 081 — wp9 implementation record: rebase no-op, CI triage, and an audit that disproved me

Closes the unit. Five fixes across three branches, each traced to a specific commit in
this stack before being changed.

## The rebase was a no-op, and that was verified rather than assumed

`080.1` planned a parent-first rebase of eight branches onto a moved `dev`. `dev` had not
moved: it sat at `50e955604` when this unit opened, the same commit the stack was built
on. Rather than skip the step, the ancestry was proved link by link —
`git merge-base --is-ancestor` for each of the nine consecutive pairs from `origin/dev`
to `codex/ocx-agent-skill`, all OK. A restack still happened, because the fixes below
landed on lower branches and had to be carried up.

Pre-rewrite SHAs were snapshotted to `/tmp/wp9snap/pre-rebase-shas.txt` before any
history was rewritten, and every push used `--force-with-lease`.

## Three CI failures, three distinct causes

CI was read for all nine PRs at once, as `080.3` requires. Grouping by cause first was
what made this cheap: two of the three failures appeared in every PR from a given depth
upward, which located them in the lowest PR showing them rather than the one where they
were noticed.

| Failure | Cause | Fixed in |
|---|---|---|
| `hygiene`: `empty_catch` on a docs-only PR | scanner matches added lines textually; two devlog lines quote the construct they argue against | `codex/ocx-agentic-control-roadmap` |
| `cli-native-profile`: expected 1, got 5 | 409 now maps to exit 5; the old assertion pinned the pre-mapping behaviour | `codex/ocx-transport-honesty` |
| `codex-retained-root-serialization`: expected 0, got 1 | a contended catalog lock was classified as a failure | `codex/ocx-uniform-contract` |

The 409 case was the only one where an existing test was edited, so it needed the
strongest justification. `025` line 51 declares the vocabulary — 0 ok, 2 usage, 4 not
found, 5 conflict — and the test asserted 1 only because every account-family failure
used to exit 1 regardless of status. It was pinning the defect. What the test exists to
cover, the idempotent cancel fallback and the absence of a spurious cleanup warning, is
untouched and still asserted.

Two CI entries that looked like failures were not: a `ci` job failing in 2–4s on every
PR was `needed job(s) did not pass: changes=cancelled`, the older run superseded by the
force-push, and a `windows-schtasks` failure timestamped before the push belonged to the
pre-push commit. Neither was chased as a defect.

## The audit disproved a premise I had asserted

The A-gate reviewer returned **fail** with two blocking findings, and both were correct.
Recorded here in full because the value of the gate is precisely that it caught something
my own scan could not.

**Finding 1 — the stack did add a real empty catch.** I had scanned every changed file
with the gate's own exported `hasEmptyCatch` and got zero matches, and concluded the
hygiene failure was purely a prose match. The scan was sound and the conclusion was
wrong: `tests/management-route-registry.test.ts:138` wrapped `Bun.writeSync?.(0, "")` in a
catch whose body is only a comment, and the regex at `pr-hygiene.cjs:113` does not match a
comment-only body. So the gate would have gone green while a genuinely swallowed failure
shipped. The call was dead anyway — the probe writes its fixture with `node:fs` on the
next line — so the block was removed rather than given a handler.

Re-scanning with a comment-aware pattern found seven more files, all pre-existing on
`dev` (zero added catch lines in each), so they are out of this unit's scope.

**Finding 2 — the first sync-cache fix masked real failures.** `ok = wrote ||
desiredDisabled || contended` treated Codex-integration-off as automatic success. But the
call passes `allowWhenDesiredDisabled: true`, so the OFF gate inside the refresh never
fires and the work is genuinely attempted. A falsy result with integration off therefore
means the refresh *failed*, and the expression returned 0 with `skipped: true` for exactly
that case — asserting a false reason, which is worse than the always-0 behaviour this unit
set out to fix. Now only `busy` is a skip; `database`, `unsafe-path`, and a falsy
`completed` all exit 1. `--json` gained `reason`, because `outcome` alone cannot separate a
contended lock from a hard serialization failure — both report `unavailable`.

## Verification

Local runs were focused, per the operator's no-full-suite constraint; the three-platform
full suite is CI's job and is what settles wp6's deferred validation (`050`
§Verification exception).

- `tsc --noEmit` clean.
- 41 tests pass across `codex-composed-acceptance`, `local-management-direct-transport`,
  `codex-retained-root-serialization`, and `cli-json-contract`; 37 across
  `management-route-registry` and `cli-native-profile` in the first round.
- Red-first proof for the contended-lock fix: dropping `contended` from the success set
  turns exactly one test red and leaves the other five passing, so the assertion is not
  vacuous.
- Detector integrity proof: `hasEmptyCatch` still returns true for a catch with a literally
  empty body and false for one that handles the error, so the reword did not weaken the
  guard. (Phrased rather than quoted, because a literal example of the construct in this
  file is itself an added line the scanner matches -- which is how this very sentence
  failed the gate once.)

## Second triage round: two more live failures, and a case both I and the audit missed

The first round's fixes exposed two failures that the earlier cancelled runs had hidden.
Both reproduced locally, so neither was treated as CI flake.

| Failure | Cause | Fixed in |
|---|---|---|
| `local-management-direct-transport`: extra `version` in identity | the version-skew fix (#2701) widened the identity payload; the exact-match assertion predates it | `codex/ocx-capability-registry` |
| `codex-composed-acceptance`: expected 0, got 1 | an absent catalog was classified as a failure | `codex/ocx-uniform-contract` |

The second one matters more than its diff suggests, because it shows the audit's finding 2
was directionally right and still not the whole answer.
`invalidateCodexModelsCacheWithPermit` returns a bare boolean for four distinct
situations -- wrote the cache, no catalog file exists, the OFF gate fired, or it threw.
So `false` cannot be read as failure any more than it could be read as success. My first
version read it as success when integration was off (masking real failures, which the
audit caught); my second read it as failure (inventing one in a native home, which the
audit did not catch because the reviewer reasoned from the reason matrix and the
`existsSync` early return is not in it).

`!existsSync(catalogPath)` is now checked at the call site and joins a contended lock as a
benign skip, with `skippedReason` in `--json` so `skipped: true` is never opaque. The check
lives at the call site rather than in the shared function because that boolean is consumed
by a dozen management routes with no use for the distinction.

The lesson worth keeping: a boolean that means four things will be misread by whoever
reads it next, in whichever direction their test happens to cover. Three consecutive
attempts got a different subset right.

Both new assertions were driven red. Reverting the `version` expectation fails exactly that
test; dropping `noCatalog` from the success set fails exactly the composed-toggle
acceptance test.


## Honest note on subagent substitution

Earlier phases in this unit recorded that subagent dispatch was failing with 429 rate
limits and that audits were performed directly. That constraint lifted here: the A-gate
reviewer for wp9 was a real dispatched `explorer` (gpt-5.6-sol, high effort), and its
two blocking findings are the substance of this record.
