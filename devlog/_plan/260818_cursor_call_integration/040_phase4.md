# 040 — WP5: merge onto dev + ancestry proof

Revised after audit `r1` finding F2.

## Authority, stated precisely

The user granted admin merge authority for this branch ("admin 권한으로") and waived
CI checking. That is the repository owner exercising owner authority.

What it is NOT: compliance with `MAINTAINERS.md:48-49`, which requires maintainer
approval **and** successful required CI checks before merge. `AGENTS.md:251-253`
makes `MAINTAINERS.md` authoritative.

So this merge is an **owner-authorized exception**, and every downstream claim must
say so. Concretely:

- The platform gap is real: lidge is Linux, CI covers Linux + Windows + macOS.
- This diff touches no Windows-sensitive surface (no shims, installer, PowerShell,
  or path handling), which is why Linux evidence is adequate *for this diff*.
- `050`'s readiness note may say "gates green on Linux; CI waived by the owner".
  It may **not** say "policy-compliant" or "all required checks passed".

If the user wants full compliance instead, the path is to let required CI run on the
PR head before merging. That is a one-line change to this plan, not a rewrite.

## Procedure

```
gh pr merge <n> --merge --admin
```

Do NOT squash. The commit-by-commit history is the audit trail for five phases of
adversarial review, and the devlog references specific SHAs — a squash breaks every
one of those references.

## Ancestry proof (the actual criterion)

A merge API response is not proof:

```
git fetch origin dev
git merge-base --is-ancestor <final-cursor-call-SHA> origin/dev   # exit 0
git log --oneline -5 origin/dev
```

## Verification (C)

Exit 0 from `--is-ancestor`, plus the `origin/dev` log showing the merge.

