# 051 — wp6 implementation record: per-account OAuth attribution (#2699)

Branch: `codex/ocx-account-attribution`, stacked on `codex/ocx-new-verbs`.
Plan: `050_phase_account_attribution.md`. All five accept criteria are met. The plan was wrong
about two things and this record says which, because both were caught by driving gates red
rather than by reading.

## What shipped

| Change | File |
|---|---|
| `o<hex6>` label family, `ACCOUNT_LOG_LABEL_RE`, `oauthAccountLogLabel` | `src/codex/account-label.ts` |
| widened persisted-label validator + `isCodexPoolAccountLogLabel` sibling | `src/usage/log.ts` |
| `stampOAuthAccountLabel` helper | `src/providers/label.ts` |
| stamp at resolve, re-stamp at the rotation chokepoint | `src/server/responses/core.ts` |
| documented why the attribution gate needs no second predicate | `src/usage/summary.ts` |

## The plan's central warning was wrong

The plan spends a paragraph on a C-ACTIVATION-GROUNDING-01 trap: stamping next to the
`genericFailoverAccountId` assignment would supposedly skip the single-account case, because
the rotation paths require two or more stored accounts.

I implemented the stamp outside that gate as instructed, then probed the warning by moving the
call *inside* `if (isGenericFailoverProvider(...))`. **All 10 tests still passed, including the
single-account activation scenario.** Removing the stamp entirely failed 2, so the tests were
not vacuous — the warning simply does not describe this predicate:

```
isGenericFailoverProvider(name, provider)   // generic-account-failover.ts:83
  → provider.authMode === "oauth" && !EXCLUDED_PROVIDERS.has(name)
```

No account count, no enablement check. It is *the same condition* the helper applies. The
two-account requirement the plan attributed to it lives in `rotateGenericOAuthAccountOn429`
(`:167`) and in `isGenericOAuthFailoverEnabled` (`:128`) — neither of which guards that
assignment.

The stamp stays outside the gate anyway, and the reason is now honest rather than borrowed: the
placement is *robust* rather than *necessary*. Attribution and 429-cooldown attribution are
different concerns that happen to share a predicate today, and a future narrowing of the
failover predicate should not silently switch usage attribution off. The code comment says that,
instead of claiming a bug that the probe disproved.

## The plan's two halves contradicted each other

050.1 says to widen the shared validator to `ACCOUNT_LOG_LABEL_RE` so "the four writers then
stop dropping `o…` labels without individual edits". 050.3 then rejects widening that same
predicate — "widening it there weakens validation for a rename's convenience" — and picks a
sibling predicate at the attribution gate instead.

Doing both is impossible, and only one order works: **the writers must accept `o`-labels or
nothing is ever persisted**, and once they do, the attribution gate is already open. So 050.1 is
implemented and 050.3's edit is deliberately a comment rather than code — a second predicate
call there would be a no-op guarded by a comment claiming otherwise.

The validation concern behind 050.3 is answered differently: `isCodexPoolAccountLogLabel` now
exists for callers that genuinely mean "a Codex pool account", and a test asserts the widened
validator still rejects `oZZZZZZ`, `oabc12`, `oabc1234`, `xabc123`, a raw account id, an email,
`null`, and `42`. Widening admitted one more shape; it did not become permissive.

## Also corrected against source

| Plan claim | Reality |
|---|---|
| four writers drop non-matching labels | **six**: `usage/log.ts:369,:456` and `request-log.ts:262,:381,:972,:1187`. The last two are in the live request path and would have dropped every new label. |
| rotation sites at `core.ts:4317,:4618,:4696,:4781` | assignments at `:2888,:4328,:4629,:5221` |
| five re-stamp sites needed | **one**: all three rotations funnel through `applyFailoverSnapshot` (`:2830`), which receives an `OAuthAccessSnapshot` carrying `accountId` |

The helper lives in `src/providers/label.ts`, not `src/codex/account-label.ts` as the plan
suggested: it needs `baseProviderLabel`, and `providers/label.ts` already imports from
`account-label.ts`, so the plan's placement would have been an import cycle. Both files are
Lab-clean, which matters because `core.ts` is one of the three files
`tests/core-lab-boundary.test.ts` guards.

## Accept criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | an xai/cursor request persists an `o<hex6>` label | single-account activation test, failover off; fails when the stamp is removed |
| 2 | a rotated request attributes to the serving account | rotation test asserts the label matches the bearer that got the 200; fails when the re-stamp is removed |
| 3 | `ocx usage` shows those accounts | two stamped accounts become two rows; fails under the pre-fix validator |
| 4 | no email or raw account id in any log | label is a sha256 digest; asserted against an email-shaped account id end to end |
| 5 | the Lab boundary still passes | `tests/core-lab-boundary.test.ts` 17 pass |

## Red probes

| Probe | Result |
|---|---|
| stamp moved inside the failover gate | **0 fail** — disproved the plan's warning |
| stamp removed entirely | 2 fail |
| re-stamp removed from `applyFailoverSnapshot` | 1 fail (the rotation test) |
| validator reverted to Codex-only | 4 fail, spanning persistence, request path, and attribution |

The last one is the useful shape: one reverted regex failed tests in three different layers,
which is the evidence that the widening genuinely carries all three rather than three separate
fixes coincidentally passing.

## Verification

```
bun test tests/oauth-account-attribution.test.ts tests/usage-summary.test.ts \
  tests/usage-log.test.ts tests/responses-account-label.test.ts \
  tests/codex-account-label.test.ts tests/core-lab-boundary.test.ts \
  tests/request-log.test.ts tests/generic-oauth-failover.test.ts
→ 187 pass, 0 fail across 8 files

./node_modules/.bin/tsc --noEmit → clean
bun run privacy:scan            → passed
```

## The verification exception still stands

This phase edits `core.ts`, the usage-log schema, and the summary rollup, so `AGENTS.md` calls
for full `bun run typecheck` and `bun run test`. Typecheck ran and is clean. The full suite is
deferred to wp9's CI pass under the operator's suspension of local suite runs. That deferral is
bounded and named in the plan: **if wp9's CI cannot run, this phase does not ship.**

## Out of scope, as decided

`supportsPerAccountQuota` (`src/providers/quota.ts`, currently anthropic-only) is per-account
*quota*, not log attribution. Left alone, recorded in `081` as a candidate follow-up.

## Subagent dispatch

Sol-tier spawns continued to return 429, so the source audit and every probe above were done
directly. Recorded rather than implied.

