# 040 — PR #298: ci: issue deduplicator workflow

- **Author:** Wibias
- **Branch:** feat/issue-deduplicator → dev
- **CI:** react-doctor pass
- **Decision:** MERGE
- **Risk:** Low (CI-only)

## Changes

1. `.github/workflows/issue-deduplicator.yml` — new workflow. Triggers on issue opened/labeled. Uses `actions/ai-inference@v1` with `openai/gpt-4o-mini` for semantic duplicate detection. Posts bot comment with up to 5 similar issues.
2. 5 commits including CodeRabbit review fixes: dropped unused `contents:read`, added concurrency group, pre-fetch bot comment for cleanup, targeted error handling on label removal.

## Security Review

- Permissions: `issues:write`, `models:read`. No secrets beyond GITHUB_TOKEN.
- Uses `actions/github-script@3a2844b` (pinned SHA).
- `actions/ai-inference@v1` — not SHA-pinned (tag only). Minor concern but GitHub-owned action. Acceptable.
- Prompt injection surface: issue body is fed to LLM, but output is constrained to JSON with issue numbers only.
