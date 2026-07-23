# 050 — PR #299: ci: issue translator workflow

- **Author:** Wibias
- **Branch:** feat/issue-translator → dev
- **CI:** react-doctor pass
- **Decision:** MERGE
- **Risk:** Low (CI-only)

## Changes

1. `.github/workflows/issue-translator.yml` — new workflow. Detects non-English issues, translates title + body to English using `actions/ai-inference` with `gpt-4o-mini`.
2. Updates issue title (for searchability/dedup compatibility with #298).
3. Posts marked bot comment with English translation.
4. 6 commits including CodeRabbit fixes: JSON parsing hardened (try raw first, then strip fences), title clamped to 256 chars, comment pagination.

## Security Review

- Permissions: `issues:write`, `models:read`. Minimal.
- Pinned `actions/ai-inference@b81b2af` and `actions/github-script@3a2844b`.
- Issue content treated as untrusted text in system prompt.
- Title mutation is deliberate and well-motivated (enables cross-language dedup).

## Note

- Missing newline at end of file (minor). Won't block merge.
