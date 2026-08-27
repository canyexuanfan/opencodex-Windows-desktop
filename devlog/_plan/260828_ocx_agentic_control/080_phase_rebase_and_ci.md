# 080 — wp9: stack rebase, final CI, parallel triage

Branch: whichever heads exist at the time. No new source scope.

The operator's instruction for this unit: no local full-suite runs during build, no
per-push CI polling. **All verification concentrates here**, which makes this phase
load-bearing rather than ceremonial.

## 080.1 — rebase the whole stack onto current `dev`

The stack is eight branches deep, so `dev` will have moved. Order matters: rebase
parent-first, then each child onto its rebased parent, or a child re-applies commits
its parent already carries.

```
git fetch origin dev
for each branch in stack order:
  git switch <branch>
  git rebase <parent>        # roadmap rebases onto origin/dev
  git push --force-with-lease --no-verify
```

`--force-with-lease`, never bare `--force`: the lease is what refuses to overwrite a
push that arrived from elsewhere. Snapshot every branch SHA before starting
(`git for-each-ref`) so any branch can be restored.

Because each child PR targets its parent's head branch, the retarget order after
rebasing is the same order — GitHub keeps the base pointer, so no PR edits are needed
unless a parent has already merged (then retarget that child to `dev`, per
`AGENTS.md`).

## 080.2 — final CI

CI runs `bun run typecheck`, `bun run test`, `bun run lint:gui`, and
`bun run privacy:scan` on Linux, Windows, and macOS. **This is where wp6's stated
verification exception is settled** (see `050` §Verification exception): the
usage-log schema and `core.ts` changes have had no local full-suite run, so a green
CI here is their only proof. If CI cannot run, wp6 does not ship.

## 080.3 — parallel triage

Read all PR check states at once rather than serially, and group failures by cause
before fixing:

- one failure appearing in every PR of the stack -> it originates in the lowest PR
  that shows it; fix there and let the rebase carry it up. Fixing it in the top PR
  leaves the stack red below.
- a failure only in one PR -> local to that phase.
- a platform-specific failure (Windows path handling, `schtasks`, case sensitivity)
  -> fix in the phase that introduced the surface, not in a follow-up.

Repeat rebase-push-check until every PR is green. A failure that reappears twice
after two different fixes stops patching and gets a root-cause pass
(`LOOP-REPAIR-01`) rather than a third guess.

## 080.4 — PR hygiene

Each PR uses `.github/PULL_REQUEST_TEMPLATE.md` with all three sections filled and
`Closes #<n>` for the issues it resolves. Since these PRs target `dev` and GitHub
only auto-closes on a default-branch merge, the issues get closed manually once the
change is on `dev`.

`enforce-target` will reject a thin description, and any PR whose title or
description mentions `gui` needs a screenshot. None of these phases changes the GUI,
so the word should not appear in a title — if a description must mention it, include
the screenshot or reword.

## Accept criteria

1. Every stacked branch is rebased on current `origin/dev`, parent-first.
2. Every PR's CI is green on all three platforms.
3. wp6's deferred full-suite validation is satisfied by that green run.
4. Every PR uses the template and links its issues.
5. No branch was force-pushed without a lease, and pre-rebase SHAs were recorded.

