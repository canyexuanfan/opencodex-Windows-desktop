# 040 — WP5: admin merge onto dev + ancestry proof

## Authorization

The user explicitly granted admin merge authority for this branch ("admin 권한으로").
CI checks are waived by the same user. That waiver covers THIS branch only.

## Procedure

Merge in dependency order (parent before child). For each PR:

```
gh pr merge <n> --merge --admin
```

Do NOT squash across the campaign: the commit-by-commit history is the audit trail
for five phases of adversarial review, and the devlog references specific SHAs.
A squash would break every one of those references.

If a child PR was stacked on a parent head branch, retarget it to `dev` after the
parent merges (`gh pr edit <n> --base dev`) before merging it.

## Ancestry proof (the actual criterion)

A merge API response is not proof. The criterion is:

```
git fetch origin dev
git merge-base --is-ancestor <final-cursor-call-SHA> origin/dev   # exit 0
git log --oneline -5 origin/dev
```

## Verification (C)

Exit 0 from `--is-ancestor` plus the `origin/dev` log showing the merge commits.

