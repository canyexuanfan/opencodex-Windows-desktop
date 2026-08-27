# 020 — publish the preview prerelease

## Target

`2.34.0-preview.20260827`, dist-tag `preview`.

## How

From a checkout on `preview`, with the deploy key exported:

```
OCX_RELEASE_SSH_KEY=~/.ssh/opencodex_release_ed25519 \
  bun scripts/release.ts 2.34.0-preview.20260827 --tag preview
```

That is the dry run — `release.yml` defaults `dry-run=true`, and the script bumps, commits,
and pushes the real release commit either way. Inspect the dispatched run, then re-run the
same command with `--publish`.

## The preflight problem, and how this phase satisfies it honestly

The preflight runs the suite locally, which is forbidden here. Do not edit the script to
skip it. Instead:

1. Run the full suite on `ssh lidge` via `ocx-run` at the exact release sha first.
2. Let `release.ts` reach its test step. If it runs the suite locally, that violates the
   constraint — so the suite step must be satisfied by the remote run and the script
   invoked in a way that does not execute it here, or the release must be dispatched
   directly via `gh workflow run release.yml` with the same `expected-sha` the script
   would have used.
3. Whichever route is taken, record which gates actually ran and where. The binding
   checks are the workflow's own: `release.yml` verifies the version matches
   `package.json` and refuses if the branch moved off `expected-sha`.

## Acceptance

- `npm view @bitkyc08/opencodex dist-tags` shows `preview = 2.34.0-preview.20260827`
- `npm view @bitkyc08/opencodex@2.34.0-preview.20260827 gitHead` equals the release commit
- the Release workflow run concluded `success` and was NOT a dry run
- Cross-platform CI and Service lifecycle were green at the release sha before dispatch
