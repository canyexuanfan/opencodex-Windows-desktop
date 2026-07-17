# Cycle 050 — Fixed Integration Matrix, SoT, and Runtime Proof

## Objective

Run a fixed final integration test, update durable documentation, inspect real GUI
artifacts, restart the actual proxy, and close every goal criterion with evidence.

## NEW `tests/openai-three-tier-e2e.test.ts`

This test is mandatory, not conditional. One config contains Direct, Multi, API,
main, and one added account. Do not add a production base-URL override: install a
test-only `globalThis.fetch` interceptor that accepts only the exact canonical
`https://chatgpt.com/backend-api/codex`, `https://api.openai.com/v1`, and explicitly
declared loopback management URLs. It captures URL, headers, and body, throws on every
unknown host/path, and `afterEach` restores the original `globalThis.fetch`.

Required scenarios:

- HTTP Direct/Multi/API and every Pro alias;
- sequential WS Direct→Multi→API→Direct with socket registry ownership checks;
- compact Direct/Multi/API/Pro, with Pro base model and no reasoning field;
- main eligibility, added-account cooldown/failover, and Multi-only outcomes;
- startup migration from `chatgpt`, second restart idempotence, backup/restore;
- catalog/disabled/subagent/injection selections preserve virtual ids;
- request log + persisted usage use virtual model, resolved model uses base;
- reverse provider insertion order produces identical routing/sidecar choices.

Every scenario asserts the captured canonical URL as well as credential and body
ownership. Passing through to the public network is forbidden; an unmatched URL is a
test failure, not a fallback.

## Client-history activation proof

Use a temporary `CODEX_HOME` and the built catalog to run one API-Pro Codex turn
against the local capture upstream. Inspect the generated rollout/session metadata:
the selected model remains `openai-apikey/gpt-5.6-*-pro`; only captured upstream JSON
contains the base id. Delete the temporary home after copying a redacted excerpt into
this document.

## MODIFY durable SoT

### `README.md`

Replace combined OpenAI/pool copy with the three-tier table, main-in-Multi statement,
selection examples, migration behavior, hidden legacy `chatgpt` note, backup restore
command, and no-push/release claim.

### `docs/codex-app-model-catalog.md`

Document bare Direct vs namespaced Multi/API, native-vs-API metadata ownership,
official 1.05M/922K facts, Pro virtual wire behavior, and compact base-only rule.

### `docs/README.md`

Add/verify the catalog link.

### OpenAI-facing files under `devlog/_chase/_model/`

Update only claims made stale by the landed implementation. Leave other providers
untouched.

## Full automated gates

```sh
bun test tests/openai-three-tier-e2e.test.ts
bun x tsc --noEmit
bun test
cd gui && bun run lint:i18n && bun run build
```

Record exit codes and pass/fail totals in this document. Full-suite success does not
replace the named activation assertions.

## Actual runtime gates

1. Restart the real proxy and record PID/version/port.
2. Direct: minimal bare native turn; provider `openai`; no pool label/state mutation.
3. Multi: namespaced supported native turn; main or configured account label and
   affinity evidence. Failover stays mocked; never exhaust live quota.
4. API: inspect config only for key presence without printing it. With an existing
   key, issue one base and three Pro prompts below 1,000 input tokens each; record only
   status/request id/selected id/resolved id. Without a key, record
   `NOT RUN (credential unavailable)` and rely on mandatory mock proof.
5. Re-open the GUI after restart and verify the four Cycle-040 screenshots against
   the landed runtime; regenerate only after a visual fix.

## Completion evidence appended here

- commits and clean worktree;
- focused/full command outputs;
- migration backup path and restore test;
- redacted history excerpt;
- GUI screenshot paths and console result;
- Direct/Multi/API runtime receipts;
- skipped live API reason when applicable;
- dead hypotheses/residual risks.

## Terminal rule

Move the unit to `_fin` only after all non-credential-gated criteria are met, the
final C adversarial review passes, and D closes to IDLE. No push, release, tag, or
deployment is part of this goal.
