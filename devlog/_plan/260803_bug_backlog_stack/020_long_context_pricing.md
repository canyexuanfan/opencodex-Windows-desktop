# 020 — Phase 2: #908 long-context pricing tiers

Stack layer 1. Work class C2: one conventional slice through an existing
pricing pipeline, no new module boundary.

## The defect

Several vendors reprice the **entire request** once the prompt crosses a token
threshold. The estimator cannot express that. `resolveMatchedPrice()` resolves
one flat `Cost4` and never sees a token count, so every request bills at the
short rate — including the long ones, which are the expensive ones.

`applyPriorityMultiplier()` (`src/usage/cost.ts:269-286`) already establishes
the shape of a conditional repricing step, but it keys off `serviceTier`, so it
cannot be reused as-is.

## The trap

The threshold is measured on **raw** `usage.inputTokens` — the total prompt
size including cache reads and writes (`src/types.ts:311-318`). But
`normalizeCostTokens()` subtracts cache read and write to produce billable
input (`src/usage/cost.ts:121`). A 280k prompt with a 200k cache read has 80k
billable input and still crosses the 272k threshold.

Selecting the tier after normalization would silently under-bill exactly the
cache-heavy long requests — the ones where being right is worth the most. Tier
selection reads `usage.inputTokens` directly; `tokens.input` is forbidden here.

## Verified thresholds

| Model | Threshold | Operator | Multiplier `in/out/cRead/cWrite` |
|---|---|---|---|
| `gpt-5.6-sol`, `-terra`, `-luna` | 272,000 | `>` | 2 / 1.5 / 2 / 2 |
| `grok-4.5` | 200,000 | `>=` | 2 / 2 / 2 / 2 |
| `MiniMax-M3` | 512,000 | `>` | 2 / 2 / 2 / 2 |

The OpenAI operator is exclusive: the page reads "Prompts with >272K input
tokens". xAI's is inclusive: "Long context ≥ 200k tokens". Getting these
backwards is a one-token error nobody would ever notice, so both boundaries get
a test.

## Model-id exactness

`src/generated/jawcode-model-metadata.ts:44` contains **both** `minimax-m3`
(0.6/2.4/0.12/0) and `MiniMax-M3` (0.3/1.2/0.06/0). The first-party registry ID
is the cased `MiniMax-M3` (`src/providers/registry.ts:247-255`). Case-folding
the lookup would select the wrong base row — the tier rule must match exactly.

Provider scoping matters for the same reason: `cursor` and `openrouter` routes
resell these models under their own terms and must not be charged first-party
tier rules.

## Design

`src/usage/expected-prices.ts` — add beside `Cost4`:

```ts
export type ContextTierName = "long";

export interface ContextTier {
  thresholdInputTokens: number;
  inclusive: boolean;
  multiplier: Cost4;
  source: string;
  verifiedAt: string;
}
```

plus an exactly-keyed `CONTEXT_TIERS` registry (`${provider}\0${modelId}`) and
`findContextTier()` / `isLongContext()`. No fuzzy matching, no case folding, no
model-level fallback. Every row records its official URL and `verifiedAt`.

`src/usage/cost.ts` — add `applyContextTier()` and insert one stage:

```text
base price → context multiplier → Fast multiplier → calculateCost
```

`resolveMatchedPrice()` stays token-independent; it is memoized by
provider/model (`src/usage/cost.ts:153-162`) and passing a token count would
poison that cache. The tier is selected after price resolution and before
`calculateCost()`, in both `estimateAttemptCost()` and `estimateRequestCost()`.

`contextTier?: ContextTierName` is added to `AttemptCostEstimate` and
`CostEstimate` so the dashboard can distinguish "long" from "just a bigger
number". A combo result carries it when any attempt does, while each attempt
keeps its own.

## Worked example

Sol, 300,000 input + 20,000 output, no cache:

- short: `300000/1e6 × 5 + 20000/1e6 × 30` = `1.50 + 0.60` = **$2.10**
- long: `300000/1e6 × 10 + 20000/1e6 × 45` = `3.00 + 0.90` = **$3.90**
- long + Fast: **$7.80**

## Tests

Extend `tests/usage-cost.test.ts` — the sibling already covering normalization,
resolution, attempts, combos, and Fast composition.

1. Each OpenAI model at exactly 272,000 (no tier) and 272,001 (tier).
2. Grok at 199,999 (no tier) and exactly 200,000 (tier) — inclusive boundary.
3. `MiniMax-M3` at 512,000 / 512,001; lowercase `minimax-m3` gets no tier.
4. **Raw-vs-normalized**: raw input above 272k with a cache read large enough
   that normalized input falls below it — tier must still activate.
5. `cursor/gpt-5.6-sol` and `openrouter/openai/gpt-5.6-sol` stay untiered.
6. An untiered model is unchanged above every threshold.
7. The $2.10 / $3.90 worked example.
8. Fast composition → $7.80.
9. Combo propagation: one long attempt + one standard attempt.

The existing Fast fixture at `tests/usage-cost.test.ts:408` uses 1M input,
which now crosses the threshold. It must move below 272k or its expected totals
change — the kind of silent fixture breakage that looks like a regression.
