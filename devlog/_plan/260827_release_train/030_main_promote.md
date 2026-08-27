# 030 — promote dev content onto main

## What changes

`main` moves from `ec51e42d7` (293 commits behind) to a merge carrying `dev`'s tree.
This is the promotion the readiness statement in `260827_dev_hardening/070` was written for.

## How

Same shape as `010`: a PR from `dev` to `main`, merged with `--admin`, because `main`
requires a pull request and the `RepositoryRole` bypass is `pull_request` only.

## Ordering

After `020`, not before. Publishing the preview channel first is what makes the stable
release a re-publication of already-exercised content rather than a first contact.

## Acceptance

- `git diff --stat origin/dev origin/main` shows only `package.json` or nothing
- the merge sha is recorded
- `main` contains `origin/dev` (`git merge-base --is-ancestor origin/dev origin/main`)

## Carried forward from the hardening unit

PR #2745 is unmerged by design, so the credential-identity drift it fixes ships to `main`
unfixed. That is disclosed in the readiness statement and is not a new decision made here.
The release notes must not imply otherwise.
