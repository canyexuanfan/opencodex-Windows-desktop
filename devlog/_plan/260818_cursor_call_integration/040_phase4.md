# 040 — WP5: merge the stack onto dev + ancestry proof

Revised by audit `r1` F2 (governance honesty) and audit `r3` F1 (base pinning).

## Authority, stated precisely

The user granted admin merge authority for this branch ("admin 권한으로") and waived
CI checking. That is the repository owner exercising owner authority.

What it is NOT: compliance with `MAINTAINERS.md:48-49`, which requires maintainer
approval **and** successful required CI checks before merge. `AGENTS.md:251-253`
makes `MAINTAINERS.md` authoritative.

So this merge is an **owner-authorized exception**, and every downstream claim must
say so:

- lidge is Linux; CI covers Linux + Windows + macOS.
- This diff touches no Windows-sensitive surface — no shims, installer, PowerShell,
  platform dispatch, or Windows path handling (verified in audit `r3`). That is why
  Linux evidence is adequate for this diff.
- `050`'s readiness note may say "gates green on Linux; CI waived by the owner". It
  may **not** say "policy-compliant" or "all required checks passed".

If the user wants full compliance instead, let required CI run on each PR head
before merging. That is a one-line change to this plan.

## Pre-merge base check (r3 F1) — do this BEFORE every merge

```
git ls-remote origin refs/heads/dev
```

Compare to `VERIFIED_BASE` from `020`. If they differ, **stop**: rebase onto the new
head and re-run the pre-merge gates. Merging a stale base lets GitHub construct a
merge result nobody tested and put it on `dev` — the ancestry check in this doc runs
*after* the merge and would discover that too late.

For PR2 and PR3 the same rule applies to their parent: after PR1 lands, retarget PR2
to `dev` (`gh pr edit <n> --base dev`), re-read the live `dev` head, and confirm it
equals PR1's merge result before merging PR2.

## Procedure

Merge in dependency order, PR1 → PR2 → PR3:

```
gh pr merge <n> --merge --admin
```

Do NOT squash. The commit-by-commit history is the audit trail for five campaign
phases plus three integration audit rounds, and the devlog references specific SHAs
— a squash breaks every one of those references.

## Ancestry proof (the actual criterion)

A merge API response is not proof:

```
git fetch origin dev
git merge-base --is-ancestor <final-stack-tip-SHA> origin/dev   # exit 0
git log --oneline -8 origin/dev
```

## Verification (C)

For each PR: the pre-merge live-`dev` SHA equal to the expected base, then exit 0
from `--is-ancestor` for the final tip, plus the `origin/dev` log showing all three
merges.

