# Release preflight research

## Sources read

- `AGENTS.md`: normal development targets `dev`; `main` is maintainer-controlled release promotion; release/security boundaries require explicit review.
- `MAINTAINERS.md:19-28`: CI, security review, direct-push, and maintainer release policy.
- `structure/06_docs-and-release.md:94-160`: release-helper flow, four-surface metadata invariant, preflight commands, full CI gates, and manual Release workflow.
- `.github/workflows/release.yml:1-380`: manual inputs, OIDC permissions, branch/tag checks, publish command, registry smoke, and tag/GitHub Release creation.
- `scripts/release.ts:1-296`: clean-tree gate, unused-version checks, local gates, package version bump, commit/push, CI waits, live-remote SHA check, and `dry-run=false` dispatch when `--publish` is supplied.

## Live evidence

- `npm view @bitkyc08/opencodex@2.7.39 version`: E404 / no matching stable version.
- `git ls-remote --tags origin refs/tags/v2.7.39 refs/tags/v2.7.39^{}`: no output.
- `gh release view v2.7.39`: release not found.
- `git show origin/main:package.json`: version 2.7.37.
- `git status --short --branch`: clean worktree on `dev` at plan time.

## Reuse decision

Use the existing `bun scripts/release.ts 2.7.39 --publish` authority. Rejected alternatives:

- Do nothing: does not satisfy the requested stable version.
- Manual `npm publish`: bypasses clean-tree, full local gates, cross-platform CI, service lifecycle, immutable-SHA, and metadata consistency controls.
- Edit release automation: unnecessary; the previous 2.7.37 OIDC release and registry smoke succeeded.
- Promote `dev`: out of scope; this request is a stable version bump on the already-audited `main` contents.
