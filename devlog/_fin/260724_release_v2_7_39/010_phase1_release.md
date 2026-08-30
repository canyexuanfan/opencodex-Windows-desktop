# Phase 1: publish stable v2.7.39

## Scope boundary

IN:

- Switch the clean checkout from `dev` to `main` and fast-forward it to live `origin/main`.
- Re-run unused-version and branch-head preflight.
- Modify only tracked `package.json` version via the existing release helper.
- Commit and push the release bump to `origin/main` under the user's release authorization.
- Wait for required CI and dispatch the Release workflow with `version=2.7.39`, `tag=latest`, `dry-run=false`, and the exact release SHA.
- Verify npm, dist-tags, tarball/CLI, Git tag, GitHub Release, and workflow identity.

OUT:

- No merge or cherry-pick from `dev`.
- No source, GUI, test, lockfile, workflow, documentation, dependency, auth, or permission edits.
- No manual tag creation, tag movement, npm unpublish/deprecate, or retry against a partially occupied version.

## Diff-level change map

### MODIFY `package.json`

Before on `origin/main`:

```json
"version": "2.7.37"
```

After:

```json
"version": "2.7.39"
```

The change is performed by `npm version 2.7.39 --no-git-tag-version` inside `scripts/release.ts`; no other tracked file may change.

## Execution order

1. Confirm clean worktree and stable 2.7.39 absence on npm/tag/GitHub Release.
2. Switch to `main`, fast-forward from `origin/main`, and verify `HEAD == origin/main` with package version 2.7.37.
3. Run `bun scripts/release.ts 2.7.39 --publish` in a managed terminal.
4. Let the helper run local typecheck, full isolated tests, and privacy scan before changing tracked state.
5. Let the helper bump only `package.json`, commit `release: v2.7.39`, push `main`, wait for Cross-platform CI and Service lifecycle, verify the live branch SHA, dispatch, and watch Release.
6. Independently verify public artifacts and perform a fresh isolated `npx` CLI version smoke.

## Acceptance criteria

- Local preflight: clean `main`, live head matches, stable 2.7.39 unused.
- Local gates: typecheck exit 0; `bun test --isolate tests` exit 0; privacy scan exit 0.
- Tracked delta at release commit: only `package.json`, exactly 2.7.37 to 2.7.39.
- GitHub Actions: Cross-platform CI, Service lifecycle, and Release all succeed for the same release SHA.
- npm: `@bitkyc08/opencodex@2.7.39` exists and `latest` equals 2.7.39; `preview` remains unchanged.
- Git: `refs/tags/v2.7.39^{}` resolves to the release SHA.
- GitHub Release: `v2.7.39` is non-draft, non-prerelease, and targets the release SHA.
- Install smoke: fresh isolated `npx --package=@bitkyc08/opencodex@2.7.39 -- ocx --version` prints `opencodex 2.7.39`.
- Security/privacy: no static npm token is introduced or printed; OIDC workflow identity remains `.github/workflows/release.yml` on `lidge-jun/opencodex`.

## Failure activation and observable proof

- Version collision: npm/tag/release preflight reports an existing artifact; stop before tracked mutation or publish.
- Branch drift: `HEAD != origin/main` before build or helper live-remote guard fails after CI; stop without dispatch.
- Quality/security failure: any local gate exits nonzero; helper must stop before version bump.
- CI failure: helper reports the failing run and does not dispatch release.
- Publish/registry failure: Release workflow fails and no completion claim is made; inspect exact job logs before any next action.
- Partial metadata: any disagreement among npm/tag/GitHub Release is UNSAFE and requires a new human decision; do not force-move metadata.
