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

## wp2 — #2085 + #2086 merged

Outcome: **DONE.**

| PR | Head reviewed | Merge commit | In `origin/dev` |
|---|---|---|---|
| #2085 admission window | `eceaf0b6e` | `e0585e59e` | yes |
| #2086 `ocx models` CLI | `f40891410` | `32d7b7939` | yes |

Both heads had moved since the earlier verdict, so the head-drift rule applied
and a fresh lane (`01a019c8`) reviewed the current code. It returned MERGE for
both, and it did the thing that makes a review verdict worth acting on: it ran
the new tests against the **unfixed** production code.

| PR | Against unfixed code | On the merged head |
|---|---|---|
| #2085 | 19 pass, **3 fail** | 22 pass, 0 fail + typecheck |
| #2086 | 16 pass, **2 fail** | 18 pass, 0 fail + typecheck |

That is a real oracle, not an assertion that the tests exist.

### What the drift check found this time

Nothing harmful — but #2086's moved head is not the diff the earlier verdict
covered. It now orders `noVisionModels` **before** `modelInputModalities`
(`src/cli/models.ts:108-109`), matching `isModelTextOnly`
(`src/vision/index.ts:33-35`), which returns on the no-vision match before it
reads modalities. That is behavior beyond a lookup migration, and it is the
correct addition: without it the CLI advertises image support the proxy then
rejects.

Two work-phases, two moved heads, two materially different diffs. The rule is
earning its cost.

### Recorded weakness

`tests/cli-models.test.ts:239-262` (exact-over-family) is **wholly vacuous** —
it passes before the fix. Merged anyway because the other two cases in that file
are genuine oracles, but it should not be cited as coverage.

### Guard held

`#2100` and `#2077` — the two HOLD verdicts from the same `modelRecordValue`
family — are still OPEN and unmerged. Merging the batch did not sweep them in.

### Batch composition check for wp3

Recorded before the next cycle so the batch is chosen on evidence rather than
on the roadmap's guess:

| PR | Owner | Files | Overlap risk |
|---|---|---|---|
| #2035 | iF2007 | `providers/antigravity-models.ts` + test | none |
| #2031 | lidge-jun | `providers/registry.ts`, `structure/03`, 2 tests | registry is a split-program target later, not now |
| #1878 | lidge-jun | one docs-site page | none |

Disjoint. Safe as one batch of three.

Note `#2031` touches `src/providers/registry.ts`, which WP3 of the split
program will eventually rewrite — but that work package is not scheduled in
this loop, so there is no ordering constraint today. Worth carrying forward if
the registry split is ever queued.

## wp3 — #2035, #1878 merged; #2031 rebased

Outcome: **DONE — all three merged.**

| PR | Merge commit | Note |
|---|---|---|
| #2035 Google reasoning tiers | `35664ad2e` | merged directly |
| #1878 tool-search docs | `a97c70d4e` | merged directly |
| #2031 MiMo vision sidecar | `7a2d13a74` | rebased first, then merged on green CI |

### The lane's verdict was right about the code and wrong about the blocker

It returned DO-NOT-MERGE on all three, but for governance reasons — "required
CI has not run", "CHANGES_REQUESTED against an older SHA", "no current
maintainer approval". Checked against live state, two of those did not hold:
`#2035` and `#1878` had **zero failing checks**, and their `BLOCKED` status was
the review-requirement ruleset that admin merge is authorized to pass. They
merged.

The lane's code analysis is what earned its keep, and it was thorough:

- **#2035** — verified no selectable tier disappears (the "collapse" in the
  title was pre-existing behavior; this PR repairs routing *after* collapse).
  Oracle: 52/0 fixed vs **50 pass 2 fail** unfixed.
- **#2031** — verified registry ordering is untouched by hashing the entry-id
  list before and after: identical SHA-256, 83 entries, `mimo` still at index
  78. That is the exact risk a registry diff carries, checked properly.
  Oracle: 50/0 fixed vs **48 pass 2 fail** unfixed.
- **#1878** — verified the documented behavior against current `dev`
  (`parser.ts:212`, `bridge.ts:639`, `parser.ts:612`) rather than just
  confirming it is docs-only. A doc describing behavior the code lacks is
  worse than no doc.

### #2031 was stale-base, and this time it was proven before merging

Its CI was genuinely red — 7 failing legs including all four test shards. The
lane called it stale-base. Rather than take that on trust:

```
git rev-list --count pr2031..origin/dev  ->  60
rebase onto origin/dev                   ->  clean, zero conflicts
bun test (both touched suites)           ->  50 pass, 0 fail
bun x tsc --noEmit                       ->  exit 0
```

Rebased and force-pushed (`dc0334eda` -> `d86a2faed`; it is a branch in our own
repo, not a fork). Cross-platform CI run `32249600228` on the new head:
**completed/success, zero failed jobs** — seven red legs became zero with no
source change other than the rebase. Merged as `7a2d13a74`.

This is the third stale-base case in this campaign. The pattern is stable
enough to name: **a red CI on a PR more than ~50 commits behind `dev` is a
claim about the base, not about the change, until a rebase says otherwise.**

Worth stating the converse too, because it is the part that keeps this honest:
the rebase does not *prove* the change is good, it removes the base as an
explanation. #2031 was mergeable because the lane had already verified the code
— registry ordering unchanged by hash, oracle red-driven — and the rebase only
cleared the noise hiding that.

### Verified clean on this head

- The key-auth test is a real oracle: it fails against `72117f169`.
- The model predicate is correctly delimited — `gpt-5.60` cannot match, unlike a
  raw `startsWith("gpt-5.6")`.
- No scope creep; no ordering conflict with `stripUnsupportedForwardParams`
  (disjoint keys).
