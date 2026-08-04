# 030 — Phase 3: stack roadmap for confirmed unresolved bugs

Ordering is by shared-file coupling and risk, not effort. Each item is one
logical change, one stacked branch (`codex/stack-NN-*`), one focused test
suite, one work-phase cycle whose P re-verifies this sketch against the
then-current tree and writes any needed sub-doc (e.g. `031_*`) before B.

| # | Branch | Issue(s) | Supersedes | Shared surface |
|---|--------|----------|-----------|----------------|
| 01 | `codex/stack-01-anthropic-400` | (this campaign's 400) | — | `src/adapters/anthropic.ts` (phase 2 output) |
| 02 | `codex/stack-02-dns-preconnect-health` | #914 | PR #966, PR #922 | `src/server/responses/core.ts`, `compact.ts` error classification |
| 03 | `codex/stack-03-sparse-snapshots` | #893 | PR #928 | `src/server/responses/core.ts` SSE assembly |
| 04 | `codex/stack-04-uuid-item-ids` | #938 | PR #940 | `src/server/responses-item-id-repair.ts` |
| 05 | `codex/stack-05-deepseek-flash-stall` | #875 | evaluate PR #1006 for adoption | `src/server/responses/core.ts` relay / registry policy |
| 06 | `codex/stack-06-jawcode-prices` | #907 | — | `src/generated/jawcode-model-metadata.ts` (+ generator source) |
| 07 | `codex/stack-07-login-url-flush` | #1007 | — | `src/cli/account-auth.ts` |
| 08 | `codex/stack-08-websearch-forced-answer` | #1001 | — | `src/web-search/loop.ts` |
| 09 | `codex/stack-09-routed-context-window` | #992 | — | `src/codex/catalog/sync.ts`, `parsing.ts` |
| 10 | `codex/stack-10-kiro-profile-arn` | #993 | — | `src/adapters/kiro.ts` |
| 11 | `codex/stack-11-provider-headers-mgmt` | #959 | relates to PR #961 (feature) | `src/server/management/provider-routes.ts`, `src/cli/provider-runtime.ts` |

Coupling notes:

- 02/03/05 all touch `core.ts`; they stack in that order so each rebase is
  mechanical.
- 05 must first decide adopt-vs-supersede on PR #1006 (its bounded-JSON
  policy may be the right vehicle; adopt if it actually fixes the stall).
- 11 overlaps feature PR #961 (custom headers management). The bug slice is
  the missing PATCH mask field; if #961 is close, prefer reviewing it forward
  instead of a competing stack PR. Decide at that cycle's P.

Verification-per-item floor: focused suite + `bun run typecheck` +
`bun run privacy:scan`; full `bun run test` on `ssh lidge` before each PR is
marked ready (deltas measured against the recorded 12-fail baseline).

Provider-live items (#875 DeepSeek, #993 Kiro, #796 Ark) cannot be live-verified
without credentials; their fixes ship with structural/fake-upstream tests and
the limitation is stated in the PR body.
