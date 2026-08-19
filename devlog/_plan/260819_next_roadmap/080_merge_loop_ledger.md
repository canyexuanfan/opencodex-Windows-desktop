# 080 — Merge-loop ledger

Append-only record for the batched merge loop. One section per work-phase.

Loop: HOTL, session `01a01949`, goalplan
`merge-the-reviewed-opencodex-pr-queue-in-small-v`.

## Standing rules

- **Small batches.** 2-4 related PRs per work-phase, never a whole stage at once.
- **Fresh review before every merge.** A verdict from an earlier session is not a
  merge authorization if the head moved.
- **HOLD list never merges:** #2100, #2077, #2056, #2062, #2063.
- **No contributor branch is ever rewritten.** Defects on a fork head are
  requested, not pushed.

### Head-drift check (added after wp1)

Record the head SHA a verdict was issued against, and re-check it before the
merge. wp1 proved why: #2102's head moved from the reviewed commit to
`914ee9372`, the author had changed the very code the verdict was about, and
merging on the stale verdict would have shipped a regression the earlier review
could not have seen.

Heads at wp2 planning time:

| PR | Head now | Verdict issued against |
|---|---|---|
| #2085 | `eceaf0b6e` | earlier session (head has since moved) |
| #2086 | `f40891410` | earlier session (head has since moved) |

Both moved. Both get a fresh lane before merging, same as #2102 did.

## wp1 — #2102 re-reviewed and deferred

Outcome: **partially blocked on the author — merge deferred, not abandoned.**

### What changed since the earlier verdict

The earlier session posted a merge recommendation for #2102 with one request: its
sanitizer sat outside the `if (forward)` branch and so also stripped
`prompt_cache_retention` from API-key passthroughs. The author pushed
`914ee9372` ("preserve key-auth cache retention") in response.

**Re-reviewing on the new head was the right call and it caught a second defect.**
Merging on the stale verdict would have shipped it.

### The remaining defect

`forward` is `provider.authMode === "forward"` alone
(`src/adapters/openai-responses.ts:1483`). That is not "the ChatGPT backend" —
this repo supports noncanonical forward providers, exercised at
`tests/openai-responses-passthrough.test.ts:19-61`.

| Provider | GPT-5.6 request |
|---|---|
| canonical ChatGPT forward | stripped — correct (#2092) |
| custom endpoint, `authMode: "forward"` | **stripped — regression** |
| API-key / custom endpoint | preserved — fixed by `914ee9372` |
| non-GPT-5.6 model | preserved |

The fix is one call: gate on `isCanonicalOpenAiForwardProvider(provider)`
(`src/providers/openai-tiers.ts:33`, already used in five places) instead of
`forward`.

**This file already makes the identical argument 30 lines below the new code**, on
the routed-compaction gate: "an authMode check would let a noncanonical custom
forward provider skip this rewrite while the server still routes it as a
summarizer turn (#422)". The same trap, caught once before, re-entered in a new
function.

### Action taken

Requested on the PR ([5341457142](https://github.com/lidge-jun/opencodex/pull/2102#issuecomment-5341457142))
with the in-file precedent quoted, rather than pushing to
`lilinxiong/fix/gpt56-prompt-cache-retention` — it is a fork head.

`#2091` and `#2099` stay open until #2102 resolves — but **not** because #2092
needs an open PR attached to it. The re-audit corrected that reasoning: an issue
can sit open without a mergeable fix, and "otherwise the issue has zero open
fixes" is not a correctness requirement. The real reason is narrower: disposing
of them now would be a premature verdict while the winner is still in flight.

Neither is a viable fallback if #2102 stalls. #2091 strips from every forward
request including GPT-5.5 and custom-forward providers. #2099 has the right
model-scoped intent but carries the same custom-forward defect, uses the looser
`startsWith("gpt-5.6")` predicate, and includes an unrelated `package.json`
version change. If #2102 stalls, #2092 stays open.

### One collision to watch

`#2040` also changes `src/adapters/openai-responses.ts` and
`tests/openai-responses-passthrough.test.ts`. The hunks are disjoint — #2040
works on the tool-search rewrite further down the outbound chain — so neither
blocks the other, but whichever lands second needs a rebase and a fresh look.

Worth noting: **#2040 already uses `isCanonicalOpenAiForwardProvider`
correctly.** Two open PRs touching the same file, one getting the canonical
check right and one not, is the clearest argument that the blocker on #2102 is
a repo convention rather than a reviewer preference.

### Not folded into the author request

Provider-qualified ids (`openai/gpt-5.6-sol`) are decoded to the bare native id
by the router (`src/router.ts:611-634`, pinned at
`tests/codex-routing.test.ts:304-309`), so the adapter only ever sees bare
GPT-5.6 ids. Asking the sanitizer to recognize the qualified form would
duplicate routing normalization. Out of scope, deliberately.

### Verified clean on this head

- The key-auth test is a real oracle: it fails against `72117f169`.
- The model predicate is correctly delimited — `gpt-5.60` cannot match, unlike a
  raw `startsWith("gpt-5.6")`.
- No scope creep; no ordering conflict with `stripUnsupportedForwardParams`
  (disjoint keys).
