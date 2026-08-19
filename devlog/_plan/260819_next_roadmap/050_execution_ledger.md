# 050 — Execution ledger

Append-only record of what each work-phase actually did, with the evidence that
establishes it. A claim without an entry here did not happen.

Loop: HOTL, session `01a01949`, goalplan
`drain-the-opencodex-pr-queue-in-reviewable-order`.

## Standing constraints

- **One merge lane only.** `#2084` then `#2089`. Every other PR in this loop is
  review, rebase, or retarget.
- **Force-push is limited to branches we own** (`codex/split-*`,
  `codex/tmp-reclaim-*`). Contributor fork heads are never rewritten; their
  bases are retargeted with `gh` instead.
- **R5 (the split program proper) is out of scope.** WP1/WP1b/WP2a get rebased
  so they stop rotting; no split train starts.

## wp0 — docs-first roadmap cycle

Outcome: **DONE.**

| Item | Evidence |
|---|---|
| Decade docs written | `000_roadmap.md`, `010`, `020`, `030`, `040` |
| Committed | `015f119d5` |
| Audit corrections | `f94cbda63` |
| Audit lane | sol-medium read-only agent `01a01963` |

### What the audit changed

Six load-bearing claims were sent to an independent lane. Four came back
CONFIRMED; two came back PARTIAL, and both PARTIALs were real errors in the
first draft, not quibbles.

**010 had the stale-base mechanism backwards.** The first draft said CI ran
"dev's newer test against the PR's older source." Run `32130164359` shows the
opposite: the *test* held the old two-argument assertion and the *source* held
the new three-argument call from `91979cf14`. `6c0bde453` fixed the assertion
afterwards. The conclusion (merge skew, not a defect) survived; the stated
mechanism did not. The draft also undercounted the failing legs — six, not
four — and called `#2023` "fully green" when `hygiene` and `enforce-target`
fail on it.

**030 overstated how reachable `#2062`'s fail-open is.** `#2056` adds
`shortPercent` to `hasKnownQuotaValue`, so short-only snapshots enter the valid
cache; `#2062` does not, so its short-only parses return `null` and the
fail-open needs disk hydration or direct cache insertion to reach. Narrower,
not absent. The audit also found a `#2062`-only defect the draft missed: a
later partial snapshot drops the preserved short tuple.

**One risk nobody had flagged:** `#2102`'s sanitizer is called outside the
`if (forward)` branch, so the chosen `prompt_cache_retention` fix also strips
the field from API-key and third-party `openai-responses` passthroughs. That is
defensible for genuine OpenAI endpoints and untested for custom ones.

The lesson worth carrying: the draft's *conclusions* held up, and its
*explanations* did not. An explanation that survives because its conclusion is
right is still wrong, and it is exactly the kind of wrong that gets copied
forward into the next document.

## wp1 — R2 merge temp-reclaim stack

Pending.

## wp2 — R1 rebase split stack

Pending.

## wp3 — R3 collisions and retargets

Pending.

## wp4 — R4 modelRecordValue batch review

Pending.
