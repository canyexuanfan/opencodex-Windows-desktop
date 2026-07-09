# Codex warmup preview release

Date: 2026-07-10
Target: `@bitkyc08/opencodex@2.7.1-preview.20260710`

## Loop specification

- Archetype: spec-satisfaction release loop
- Trigger: publish the already committed Codex warmup fix and Cursor GPT-5.6 catalog additions after the first release attempt stopped before publication
- Goal: publish the target version with npm dist-tag `preview` and create the matching prerelease GitHub Release
- Non-goals: no application-code changes, no additional version bump, no change to npm dist-tag `latest`, and no unrelated workspace cleanup
- Verifier: successful Cross-platform CI and Release workflow runs for the exact release HEAD, followed by npm and GitHub artifact queries
- Stop condition: npm exposes the target version under `preview`, `latest` remains `2.7.0`, and GitHub exposes the matching prerelease tag/release at the release HEAD
- Memory artifact: this implementation unit and its phase document
- Expected terminal outcomes: `DONE` after all public artifacts agree; `BLOCKED` for unavailable credentials or infrastructure; `UNSAFE` if public metadata becomes inconsistent and an automatic retry could duplicate or mispoint a release
- Escalation condition: npm publication succeeds but tag/release creation fails, the release branch moves during verification, or trusted publishing rejects the workflow identity

## Baseline

- Branch: `preview`
- Initial release HEAD: `3ce5f9c0806962037c0458849113b87d7b498c08`
- Package version: `2.7.1-preview.20260710`
- Included commits:
  - `a3cc86e8` sends Codex warmup input as Responses API message items
  - `b46dc824` updates remaining warmup payload regression expectations
  - `3ce5f9c0` adds the requested Cursor GPT-5.6 preview models
- Existing public channels before release:
  - npm `latest`: `2.7.0`
  - npm `preview`: `2.6.31-preview.20260707`
- Target version, Git tag, and GitHub Release were absent at preflight.
- Cross-platform CI run `29037460039` for the initial HEAD was cancelled while the Windows test step was running; completed macOS, Ubuntu, and npm-global jobs passed. A successful run for the final release HEAD is still required.
- Service lifecycle run `29037205875` passed at `aca3219e`, but the release workflow requires a successful run for the exact final release HEAD because `package.json` changed after `v2.7.0`.
- A devlog-only push does not match either workflow's push path filters. Both `ci.yml` and `service-lifecycle.yml` therefore require explicit `workflow_dispatch` runs after the record commit.

## Scope and file map

- NEW `devlog/_plan/260710_codex_warmup_preview_release/000_plan.md`: durable release intent, risks, and evidence ledger
- NEW `devlog/_plan/260710_codex_warmup_preview_release/010_phase1_preview_release.md`: exact release execution and verification procedure
- REMOTE GitHub Actions state: Cross-platform CI rerun/new run, then one real `Release` workflow dispatch from `preview`
- REMOTE npm/GitHub state: publish the target version, move only the `preview` dist-tag, create the matching Git tag and prerelease
- OUT: `src/**`, `tests/**`, workflow definitions, dependency files, and all unrelated user files

## Dependency-ordered work phase

1. Record this plan and audit it against `scripts/release.ts` and `.github/workflows/release.yml`.
2. Commit and push the audited release record so the final release HEAD is immutable and known.
3. Manually dispatch both Cross-platform CI and Service lifecycle from `preview`, then require successful runs for that exact HEAD.
4. Dispatch one non-dry-run Release workflow with version `2.7.1-preview.20260710` and tag `preview`.
5. Verify the workflow result, npm version/dist-tags, remote tag target, and GitHub prerelease metadata.
6. Append closure evidence, archive this unit under `devlog/_fin/`, commit, and push the record.

## Risks and recovery

- CI cancellation or failure: inspect the exact latest-HEAD job state before rerunning or editing; do not treat partial green jobs as a successful run.
- Branch drift: abort dispatch if `origin/preview` no longer matches the audited release HEAD.
- Partial npm release: npm versions are immutable. If publication succeeds but GitHub metadata fails, do not republish the same version; repair only the missing tag/release against the published HEAD after confirming npm state.
- Bad preview rollout: restore npm `preview` to `2.6.31-preview.20260707`; leave the immutable published version and release evidence intact.
- Stable-channel safety: verify `latest` remains `2.7.0` after publication.

## Acceptance criteria

- The final release HEAD has a completed Cross-platform CI run with conclusion `success`.
- The final release HEAD has a completed Service lifecycle run with conclusion `success`.
- The Release workflow completes successfully for that same HEAD with `dry-run=false`, tag `preview`, and the target version.
- `npm view @bitkyc08/opencodex@2.7.1-preview.20260710 version` returns the target version.
- `npm dist-tag ls @bitkyc08/opencodex` reports `preview: 2.7.1-preview.20260710` and `latest: 2.7.0`.
- Remote tag `v2.7.1-preview.20260710` resolves to the release HEAD.
- The GitHub Release for that tag exists and is marked prerelease.
- The working tree is clean after the closure-record commit and push.

## Evidence ledger

Preflight evidence is recorded above. Final CI, workflow, registry, tag, and release evidence is appended during the D phase before this unit is archived.
