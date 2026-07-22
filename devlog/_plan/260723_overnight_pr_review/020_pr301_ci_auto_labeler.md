# 020 — PR #301: ci: PR auto-labeler + auto release notes

- **Author:** Wibias
- **Branch:** feat/auto-release-notes → dev
- **CI:** All pass (7/7 checks)
- **Decision:** MERGE
- **Risk:** Low (CI-only, no runtime changes)

## Changes

1. `.github/workflows/pr-labeler.yml` — new workflow. Labels PRs from conventional-commit title prefix (feat→enhancement, fix→bug, etc). Uses `actions/github-script@60a0d83` (pinned).
2. `.github/release.yml` — new config. Maps labels to release note sections.
3. `.github/workflows/release.yml` — removes manual git-log notes generation, uses `--generate-notes`.

## Security Review

- Permissions: `contents:read`, `pull-requests:write` — minimal.
- Pinned action ref (SHA, not tag). Good.
- Modifies release.yml: change is a net REMOVAL of shell scripting in favor of GitHub built-in `--generate-notes`. Safer.
- NOTE: requires `chore` label to exist. Author left instructions in PR description.
