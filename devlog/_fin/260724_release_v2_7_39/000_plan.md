# Stable npm release v2.7.39

Date: 2026-07-24
Class: C4 (public package release, irreversible registry publication)
Owner approval: the project owner requested the stable version bump to 2.7.39 in this session.

## Loop specification

- Loop archetype: repair/release completion.
- Trigger: stable `2.7.37` is published; the owner requested the next stable release as `2.7.39`.
- Goal: publish `@bitkyc08/opencodex@2.7.39` under npm dist-tag `latest`, with matching Git tag and GitHub Release at one immutable release commit.
- Non-goals: no promotion of new `dev` commits, no runtime/GUI/workflow edits, no dependency changes, no tag rewrites, and no publication under `preview`.
- Verifier: local release-helper gates; successful Cross-platform CI and Service lifecycle runs for the release SHA; Release workflow success; registry/tag/GitHub Release/install smoke checks.
- Stop condition: all four release metadata surfaces agree on 2.7.39 and a fresh `npx` invocation reports `opencodex 2.7.39`.
- Memory artifact: this unit under `devlog/_plan/260724_release_v2_7_39`, moved to `_fin` at closure.
- Expected terminal outcomes: DONE if all surfaces agree; UNSAFE if 2.7.39 becomes occupied or the audited branch moves; BLOCKED if required CI or OIDC publishing fails.
- Escalation condition: stop without retrying publication if npm, tag, or GitHub Release becomes partially occupied; stop if `origin/main` moves after the release commit or if any security/privacy gate fails.

## Baseline

- Live `origin/main`: `b9a5d39878a6e7253298d97fd147a2ac975854d2` (`release: v2.7.37`).
- `origin/main:package.json`: `2.7.37`.
- npm stable `latest`: `2.7.37`.
- npm preview: `2.7.39-preview.20260724`; this does not consume stable semver `2.7.39`.
- Stable `2.7.39` preflight: absent from npm, `refs/tags/v2.7.39`, and GitHub Releases.
- Current local branch at planning time: clean `dev`; build must switch to clean `main` and revalidate the live remote head.

## Work-phase map

One work-phase only: `010_phase1_release.md` performs the audited stable release and verifies every public surface. There are no conditional code paths to add; failure branches belong to the existing release helper and are exercised by metadata/branch/CI preflight observations.

## Risks and controls

- Irreversible npm publish: require unused-version preflight immediately before execution and let `scripts/release.ts` fail closed.
- Wrong branch or stale head: switch to `main`, fast-forward from `origin/main`, require clean worktree, and rely on the helper's live-remote SHA guard.
- Unverified package: run the helper's typecheck, full isolated tests, privacy scan, Cross-platform CI, Service lifecycle, and registry smoke.
- Partial metadata: never create/move tags manually; let the workflow publish first and create the matching tag/release only after registry smoke.
- Credential exposure: retain OIDC trusted publishing; inspect outputs for accidental secret disclosure and do not introduce tokens.

## Approval and security review

- User authorization: stable 2.7.39 release requested in the current conversation.
- Repository policy: maintainer-controlled direct release is permitted; this plan receives an independent A-phase review before any mutation.
- No release automation, auth configuration, dependencies, or workflow permissions are changed.

## Independent audit

- Reviewer: independent A-phase subagent using a different model family.
- Verdict: PASS; blockers: 0.
- Confirmed: stable 2.7.39 is unused; the preview with the same base version does not conflict; skipping stable 2.7.38 is allowed; wrong-branch, CI, drift, OIDC, partial-metadata, and clean-tree gates are reachable and observable.
- Residuals: stable 2.7.38 remains a cosmetic version gap; slow CI can safely time out; neither residual changes the execution plan.

## Closure evidence

- Terminal outcome: DONE.
- Release commit: `357acee62458684bc027e9d524e95bd066df3a43` (`release: v2.7.39`).
- Tracked delta: only `package.json`, version 2.7.37 to 2.7.39.
- Local gates: typecheck passed; `4024 pass / 0 fail` across 318 files; privacy scan passed.
- GitHub Actions: Cross-platform CI `30073226065`, Service lifecycle `30073226071`, and Release `30073562521` all succeeded for the release SHA.
- npm: `@bitkyc08/opencodex@2.7.39` published at `2026-07-24T06:52:36.967Z`; `latest=2.7.39`; integrity `sha512-Vy9DBmXw27x7RNKrlWhIMD0kD0qhamJ9LCBctW+lepac2+rL1gKqEXBCSIfsMCqCGUk5kFKSakEYXUyMpbYD6w==`.
- Git metadata: lightweight `v2.7.39` tag and non-draft, non-prerelease GitHub Release both target the release SHA.
- Fresh install smoke: isolated npm cache plus `npx --package=@bitkyc08/opencodex@2.7.39 -- ocx --version` printed `opencodex 2.7.39`.
- Residual: this Mac had no global macOS Bun on PATH and the local `node_modules/.bin/bun` pointed to a Windows binary; execution used npm's temporary macOS `bun@1.3.14` package without changing tracked files. This did not affect CI or the published artifact.
