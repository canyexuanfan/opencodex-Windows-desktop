# 030 — Phase 3: stack roadmap for confirmed unresolved bugs

This is the execution sketch, not the plan of record for each item. Each item
becomes executable when its own cycle's P writes its diff-level sub-doc
(`031_*`…) against the then-current tree (LOOP-UNIT-CHAIN-01); items whose
rows carry a blocking open question are decided at that P, not here.

Dependency structure (amended after audit round 1): only the `core.ts`
cluster (02, 03, 05) chains branches. Every other item branches from
`origin/dev` independently — they share no files and must not inherit each
other's merge blockage.

| # | Branch | Issue(s) | Supersedes | Surface | Chain |
|---|--------|----------|-----------|---------|-------|
| 02 | `codex/stack-02-dns-preconnect-health` | #914 | PR #966, PR #922 | `src/server/responses/core.ts`, `compact.ts` | core.ts 1/3 |
| 03 | `codex/stack-03-sparse-snapshots` | #893 | PR #928 | `src/server/responses/core.ts` SSE assembly | core.ts 2/3 |
| 05 | `codex/stack-05-deepseek-flash-stall` | #875 | evaluate PR #1006 for adoption | `src/server/responses/core.ts` relay / registry policy | core.ts 3/3 |
| 04 | `codex/stack-04-uuid-item-ids` | #938 | PR #940 | `src/server/responses-item-id-repair.ts` | independent |
| 06 | `codex/stack-06-jawcode-prices` | #907 | — | `src/generated/jawcode-model-metadata.ts` | independent, see authority note |
| 07 | `codex/stack-07-login-url-flush` | #1007 | — | `src/cli/account-auth.ts` | independent |
| 08 | `codex/stack-08-websearch-forced-answer` | #1001 | — | `src/web-search/loop.ts` | independent |
| 09 | `codex/stack-09-routed-context-window` | #992 | — | `src/codex/catalog/sync.ts`, `parsing.ts` | independent |
| 10 | `codex/stack-10-kiro-profile-arn` | #993 | — | `src/adapters/kiro.ts` | independent |
| 11 | `codex/stack-11-provider-headers-mgmt` | #959 | relates to PR #961 (feature) | `src/server/management/provider-routes.ts`, `src/cli/provider-runtime.ts` | independent |

(The anthropic 400 fix is phase 2's output; it is not a phase-3 item.)

Per-item open questions to resolve at each cycle's P:

- 05: adopt-vs-supersede PR #1006 (its bounded-JSON policy may be the right
  vehicle; adopt if it actually fixes the stall).
- 06: `jawcode-model-metadata.ts` is generated ("do not edit manually"); the
  generator expects `../jawcode/packages/ai/src/models.json` — an external
  checkout requiring separate write authority. Decide: regenerate with the
  user's jawcode checkout present, or patch in-repo with a source-fix note.
  Escalate to the user (NEEDS_HUMAN) if neither is clean.
- 07: "no explicit flush" is a symptom, not a repair. The fix needs a concrete
  write primitive (e.g. `process.stdout.write` + drain await, or an fd-level
  sync write for the URL line) and a pipe-based regression test (stdout
  redirected to a pipe, assert the URL is readable before auth completes).
- 11: overlaps feature PR #961 (custom headers management). If #961 is close,
  prefer reviewing it forward over a competing stack PR.

Verification-per-item floor: focused suite + `bun run typecheck` +
`bun run privacy:scan`; full `bun run test` on `ssh lidge` before each PR is
marked ready (deltas measured against the recorded 12-fail baseline).

Provider-live items (#875 DeepSeek, #993 Kiro, #796 Ark) cannot be live-verified
without credentials; their fixes ship with structural/fake-upstream tests and
the limitation is stated in the PR body.
