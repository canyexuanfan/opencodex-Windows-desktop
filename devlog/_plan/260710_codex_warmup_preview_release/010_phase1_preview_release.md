# Phase 1: publish the preview package

## Inputs

- Branch: `preview`
- Version: `2.7.1-preview.20260710`
- npm dist-tag: `preview`
- Release workflow: `.github/workflows/release.yml`
- Release helper contract: `scripts/release.ts`

## Planned repository delta

- Add only this implementation unit before publication.
- Do not rerun `scripts/release.ts` with the same version because `package.json` is already bumped and the helper would attempt a second version-bump commit.
- Do not modify application code, tests, workflow YAML, lockfiles, or package metadata.

## Execution

1. Audit the target version, branch/tag pairing, unused public metadata, and recovery plan.
2. Commit the two release-record files and push `preview`.
3. Capture the resulting HEAD. Because a devlog-only push matches neither workflow's path filters, explicitly dispatch both prerequisite workflows from `preview`:

   ```bash
   gh workflow run ci.yml --ref preview
   gh workflow run service-lifecycle.yml --ref preview
   ```

4. Identify both new runs by branch, exact HEAD, and creation time; require each to finish with conclusion `success`.
5. Confirm `origin/preview` still equals that SHA.
6. Dispatch:

   ```bash
   gh workflow run release.yml --ref preview \
     -f version=2.7.1-preview.20260710 \
     -f tag=preview \
     -f dry-run=false
   ```

7. Identify the newly dispatched Release run by branch, commit, and creation time; watch it to completion with exit status enforcement.
8. Query npm, the remote Git tag, and the GitHub Release independently after the workflow succeeds.

## Gate activation evidence

- CI gate: the Release workflow queries successful `ci.yml` runs for its own `GITHUB_SHA`; the observed workflow log must name the successful run URL.
- Service lifecycle gate: because `package.json` changed since `v2.7.0`, the Release workflow queries a successful `service-lifecycle.yml` run for its own `GITHUB_SHA`; the observed workflow log must name that run URL.
- Version gate: workflow input must equal `package.json` exactly; the observed log must show matching values.
- Channel gate: `preview` branch requires a prerelease version and npm tag `preview`; the observed workflow must pass this validation.
- Public-metadata preflight: target npm version, Git tag, and GitHub Release must all be absent before dispatch.
- Registry smoke: after publish, the workflow must observe the exact version from npm before creating release metadata.

These are existing workflow branches, not new code paths. Evidence comes from the real release run rather than synthetic branch tests.

## Verification commands

```bash
gh run view <ci-run-id> --json status,conclusion,url,headSha,jobs
gh run view <service-run-id> --json status,conclusion,url,headSha,jobs
gh run view <release-run-id> --json status,conclusion,url,headSha,jobs
npm view @bitkyc08/opencodex@2.7.1-preview.20260710 version
npm dist-tag ls @bitkyc08/opencodex
git ls-remote origin refs/tags/v2.7.1-preview.20260710
gh release view v2.7.1-preview.20260710 --json tagName,targetCommitish,url,isPrerelease
```

## Recovery boundary

- Before npm publication: a failed run is retryable only after inspecting the failed job and confirming all public metadata remains absent.
- After npm publication: do not retry the publish step for the same version. Reconcile npm, tag, and GitHub Release state and repair only the missing metadata.
- If the published preview is unusable: move npm `preview` back to `2.6.31-preview.20260707`; do not alter `latest`.

## Done criteria

All acceptance criteria in `000_plan.md` are proven with fresh command output, the evidence ledger is complete, and the implementation unit is archived under `devlog/_fin/`.
