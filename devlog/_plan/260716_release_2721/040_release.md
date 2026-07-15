# 040 — Phase 4: main/preview merge + npm publish

## Merge safety assessment (do first, record)

- `git log --oneline dev..origin/main` must be empty (main strictly behind dev) ⇒
  merge is fast-forward-able; use `--no-ff` merge commit for a release boundary.
- Same check for preview. Both were at ee5f6ad2 == main at plan time.

## Main channel (dist-tag latest)

```sh
git checkout main && git pull origin main
git merge --no-ff dev -m "Merge branch 'dev' (v2.7.21: PR #136 + #137 + usage surface filter)"
git push origin main            # PRs 136/137 flip to MERGED here
bun scripts/release.ts 2.7.21 --tag latest --publish
```

release.ts handles: preflight → bump package.json to 2.7.21 → commit+push → wait
ci.yml on bump SHA → dispatch release.yml → watch. The bump commit touches
package.json ⇒ service-lifecycle.yml auto-runs on push; release gate requires its
success for the SHA.

## Preview channel (dist-tag preview)

```sh
git checkout preview && git pull origin preview
git merge --no-ff main -m "Merge branch 'main' into preview (v2.7.21)"
git push origin preview
bun scripts/release.ts 2.7.21-preview.20260716 --tag preview --publish
```

Pattern matches history (`release: v2.7.11-preview.20260713` bump commits live on
preview). Version regex gate: `*-preview.*` ✓.

## Post-publish verification

```sh
npm view @bitkyc08/opencodex dist-tags   # expect latest:2.7.21, preview:2.7.21-preview.20260716
gh pr view 136 --json state; gh pr view 137 --json state   # expect MERGED
gh run list --branch main --limit 3; gh run list --branch preview --limit 3
```

## Accept criteria

- Both release.yml runs conclusion=success with `--publish` (not dry-run).
- npm dist-tags updated; PRs merged; all three branches green.
- Devlog unit closes: evidence appended here, unit promoted per repo convention at D.

## Failure modes

- CI wait timeout (20min) in release.ts, or release.yml gate failure after the bump
  commit already landed: do NOT rerun the full release helper (npm version would fail
  on the already-bumped tree). Manual recovery once all SHA-gates are green:

  ```sh
  gh workflow run release.yml --ref <main|preview> \
    -f version=<version> -f tag=<latest|preview> -f dry-run=false
  gh run list --workflow release.yml --limit 1 --json databaseId,url  # identify the NEW run
  gh run watch <that-run-id> --exit-status
  ```

- service-lifecycle missing for bump SHA → wait for the auto-triggered run (bump touches
  package.json, a real trigger path), then manual re-dispatch as above.
- OIDC publish failure → NEEDS_HUMAN (npm trusted-publisher config is account-side).

## Preflight evidence (recorded 2026-07-16, pre-mutation)

- `gh auth status`: lidge-jun, active, scopes gist/read:org/repo/workflow; repo permission ADMIN.
- Branch protection: main/dev/preview all 404 "Branch not protected"; rulesets `[]`.
- Trusted publishing: last successful publish run exists for main ee5f6ad2 (v2.7.20).
- Target versions 2.7.21 and 2.7.21-preview.20260716 both npm-404 (unused).

## Evidence (filled at C/D)

- (pending)
