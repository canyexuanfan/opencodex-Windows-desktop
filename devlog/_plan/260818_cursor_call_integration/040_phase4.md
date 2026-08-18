# 040 — WP5: merge the stack onto dev + ancestry proof

Revised by `r1` F2 (governance honesty), `r3` F1 (base pinning), and `r4` F1 (the
pin has to EVOLVE through the stack).

## Authority, stated precisely

The user granted admin merge authority for this branch ("admin 권한으로") and waived
CI checking. That is the repository owner exercising owner authority.

What it is NOT: compliance with `MAINTAINERS.md:48-49`, which requires maintainer
approval **and** successful required CI checks before merge. `AGENTS.md:251-253`
makes `MAINTAINERS.md` authoritative.

So each merge is an **owner-authorized exception**:

- lidge is Linux; CI covers Linux + Windows + macOS.
- This diff touches no Windows-sensitive surface — no shims, installer, PowerShell,
  platform dispatch, or Windows path handling (verified in `r3` and `r4`).
- `050`'s note may say "gates green on Linux; CI waived by the owner". It may **not**
  say "policy-compliant" or "all required checks passed".

If the user wants full compliance instead, let required CI run on each PR head
before merging. One-line change to this plan.

## `EXPECTED_DEV` evolves — it is not one frozen SHA (r4 F1)

`VERIFIED_BASE` (the SHA WP3 verified against) is correct as the value to check
before PR1. After PR1 merges, `dev` legitimately moves to PR1's merge result, so
comparing PR2 against the original value would fail by construction.

The invariant is: **before merging layer N, the live `dev` head must equal the SHA
that layer N's base was verified against.** Maintain one variable:

    EXPECTED_DEV="$VERIFIED_BASE"                       # from 020, the rebase target

    # per layer N, with PRN and PRN_HEAD from 030 step 5:
    test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$EXPECTED_DEV"
    test "$(gh pr view $PRN --json headRefOid --jq .headRefOid)" = "$PRN_HEAD"
    gh pr merge $PRN --merge --admin
    EXPECTED_DEV=$(gh pr view $PRN --json mergeCommit --jq .mergeCommit.oid)
    gh pr edit $PR_NEXT --base dev                      # retarget the next layer

`EXPECTED_DEV` advances to the MERGE COMMIT of the layer just landed, not to a fresh
read of `dev` — same reason as `MERGED_DEV` below (audit `r13`).

Read the live head with `git ls-remote origin refs/heads/dev` every time, never
`origin/dev` — the tracking ref goes stale within minutes
(`scripts/release.ts:327-335` uses `ls-remote` for exactly this reason). Observed
drift during planning alone: `87f7f970b` → `e1bdbc1e5` → `1645bb924`.

**If a check fails**, someone else pushed to `dev`. Stop: rebase the remaining
layers onto the new head, re-run the affected gates from `020`, and update
`EXPECTED_DEV`. Merging a stale base lets GitHub construct a merge result nobody
tested and put it on `dev` — and the ancestry check below runs afterwards, too late
to prevent it.

## Procedure

Merge in dependency order, PR1 → PR2 → PR3, with the base check before each:

    test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$EXPECTED_DEV"
    gh pr merge $PRN --merge --admin
    gh pr edit $PR_NEXT --base dev              # retarget the next layer

### Also assert the PR HEAD, not just the base (audit `r10`)

The base check proves `dev` has not moved. It says nothing about what the PR itself
now points at. A force-push to a PR head — by anyone, including a well-meaning
rebase — would merge commits that never went through `020`'s gates, and the
post-merge ancestry check below would still pass, because the verified tip remains an
ancestor of a superset.

So before EACH merge, compare the PR's live head against the SHA `030` step 5
recorded:

    test "$(gh pr view <n> --json headRefOid --jq .headRefOid)" = "$PR1_HEAD"
    gh pr merge <n> --merge --admin

`test`, not a printed value: a comparison the operator has to eyeball is not a gate
(audit `r13`). Repeat with `$PR2_HEAD` and `$PR3_HEAD` for the other two layers.

### And assert the PR's live BASE (audit `r14`)

The two checks above cover "has `dev` moved" and "has the PR head moved". Neither
covers "is this PR still pointing at `dev`". A retarget — to `main`, or to a parent
branch that has since merged — passes both, and `gh pr merge` would then merge into
whatever base the PR now names. `030` prints the bases for inspection, which is not a
gate.

So the pre-merge check for EVERY layer is all three at once:

    PR_BASE=$(gh pr view $PRN --json baseRefName --jq .baseRefName)
    PR_HEAD=$(gh pr view $PRN --json headRefOid --jq .headRefOid)
    test "$PR_BASE" = "dev"
    test "$PR_HEAD" = "$EXPECTED_HEAD"
    test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$EXPECTED_DEV"
    gh pr merge $PRN --merge --admin

`dev` is the only acceptable base for all three layers at merge time: PR1 targets it
from the start, and PR2/PR3 are retargeted to it as their parents land
(`AGENTS.md:218-225`). A base of `main` would be a policy violation, and a base still
naming a merged parent branch would produce an empty or wrong diff.

PR3's expected head is `VERIFIED_TIP` — the exact SHA `020` ran the full suite
against. If any head differs, stop: either re-verify that tree through `020` or
reset the branch to the recorded SHA. Never merge a head no gate has seen.

Do NOT squash. The commit-by-commit history is the audit trail for five campaign
phases plus four integration audit rounds, and the devlog references specific SHAs.

## Ancestry proof (the actual criterion)

A merge API response is not proof:

```
git fetch origin dev
git merge-base --is-ancestor <final-stack-tip-SHA> origin/dev   # exit 0
git log --oneline -10 origin/dev
```

## Verification (C)

For each layer: the pre-merge `ls-remote` SHA equal to the then-current
`EXPECTED_DEV`, recorded. Then exit 0 from `--is-ancestor` for the final tip, plus
the `origin/dev` log showing all three merges.

## Hand `MERGED_DEV` to WP6

After PR3 merges, take the result from the MERGE ITSELF rather than re-reading a
mutable ref — a fresh `ls-remote` would silently pick up a concurrent push and
attribute someone else's commit to this campaign (audit `r13`):

    MERGED_DEV=$(gh pr view <pr3> --json mergeCommit --jq .mergeCommit.oid)
    test -n "$MERGED_DEV"
    git fetch origin dev
    test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$MERGED_DEV"   # nobody pushed after us
    git merge-base --is-ancestor "$VERIFIED_TIP" "$MERGED_DEV"                # exit 0

If the third assertion fails, someone pushed after PR3 landed. That is not
necessarily wrong, but `050` must then gate `MERGED_DEV` explicitly and say in the
readiness note that `dev` has moved past it.

`050` gates exactly that SHA. Same reason as every other named artifact here: a
phase that re-reads a mutable ref is not verifying what the previous phase produced
(audits `r7`, `r8`, `r10`).
