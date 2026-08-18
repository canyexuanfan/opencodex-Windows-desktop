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

    EXPECTED_DEV := VERIFIED_BASE          # from 020, the rebase target
    before PR1:  git ls-remote origin refs/heads/dev  == EXPECTED_DEV
    merge PR1
    EXPECTED_DEV := <PR1 merge result on dev>
    retarget PR2 to dev, then:  live dev == EXPECTED_DEV
    merge PR2
    EXPECTED_DEV := <PR2 merge result on dev>
    retarget PR3 to dev, then:  live dev == EXPECTED_DEV
    merge PR3

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

```
git ls-remote origin refs/heads/dev        # must equal EXPECTED_DEV
gh pr merge <n> --merge --admin
gh pr edit <child> --base dev              # retarget the next layer
```

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

