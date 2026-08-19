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

## wp1 — #2102 + close #2091/#2099

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

`#2091` and `#2099` stay open until #2102 lands. Closing them now would leave
#2092 with no open fix.

### Verified clean on this head

- The key-auth test is a real oracle: it fails against `72117f169`.
- The model predicate is correctly delimited — `gpt-5.60` cannot match, unlike a
  raw `startsWith("gpt-5.6")`.
- No scope creep; no ordering conflict with `stripUnsupportedForwardParams`
  (disjoint keys).
