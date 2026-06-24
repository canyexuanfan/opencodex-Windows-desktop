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
wc -l src/server.ts src/codex-auth-api.ts src/codex-auth-collision.ts src/codex-routing.ts tests/codex-auth-api.test.ts tests/codex-routing.test.ts tests/codex-auth-collision.test.ts
LC_ALL=C rg -n "[^\\x00-\\x7F]" devlog/_plan/260624_codex-auth-verification-loop devlog/270_codex-multi-account-auth/160_post-implementation-verification-results.md
```

File-length guard:

- Do not add routing/failover logic inline to `src/server.ts`; extract `src/codex-routing.ts` first.
- Do not add new routing/failover tests to `tests/codex-auth-api.test.ts`; use `tests/codex-routing.test.ts`.

Results: pending.
