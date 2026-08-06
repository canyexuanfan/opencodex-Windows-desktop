# 020 — wp2: #1090 external-provider config preservation test

## Finding (audited)

Attempt 1 of the report (explicit `model_provider = "deepseek"`) is fixed on
dev: `externalCodexModelProvider()` (`src/codex/inject.ts:74`) recognizes
non-`openai`/`opencodex` providers and `injectCodexConfig()` returns before
any write (`inject.ts:636-658`). Attempt 3 (`model_provider = "opencodex"`)
intentionally re-runs injection (`inject.ts:701-747`) — that is the routed
mode working as designed, but the full issue read must confirm the
reporter's complaint there is only the unreachable-chatgpt.com symptom.

## Work

1. Read the full issue thread; classify attempt 3 as by-design or residual
   defect.
2. Add a focused regression test near the existing inject tests: a config
   with an external `model_provider` and custom `openai_base_url` must
   survive `injectCodexConfig()` byte-identical (the missing coverage the
   audit confirmed).
3. Red-ablation: revert the guard locally, prove the test fails, restore.
4. `bun run typecheck` + focused test file green.
5. Disposition: close #1090 with evidence only if attempt-3 is by-design;
   otherwise status comment with the split.

## Ledger

| Step | Evidence |
|------|----------|
