# 20 - Loop 2 Static and Test Results

Status: planned.

Commands to run:

```bash
git diff --check
bun run typecheck
cd gui && bun run build
bun test tests
```

Additional checks:

```bash
wc -l src/codex-auth-api.ts src/codex-auth-collision.ts tests/codex-auth-api.test.ts tests/codex-auth-collision.test.ts
LC_ALL=C rg -n "[^\\x00-\\x7F]" devlog/_plan/260624_codex-auth-verification-loop devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md
```

Results: pending.
