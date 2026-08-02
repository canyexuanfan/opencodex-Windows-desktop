---
title: Model Ordering
description: How opencodex determines model order in the Codex picker and spawn_agent model overrides.
---

The Codex model picker does not preserve the order of provider declarations or model arrays in the
opencodex configuration. Its final order comes from catalog priorities, with a deterministic
alphabetical order for routed models that share the same priority.

## The rule Codex applies

Codex's models-manager sorts picker-visible catalog entries by `priority` in ascending order. It
discards the catalog array order, so moving an entry earlier in a generated JSON array does not move
it earlier in the picker. The implementation records this constraint directly in
`src/codex/catalog/sync.ts`.

opencodex therefore controls featured placement by assigning lower priorities, not by relying on
array position. The relevant priorities are:

| Catalog entry | Priority | Source |
| --- | ---: | --- |
| `subagentModels[i]` | `i` (`0` through `4`) | The featured rank map in `src/codex/catalog/sync.ts` |
| Other routed models | `5` | Routed entry creation in `src/codex/catalog/sync.ts` |
| Native GPT slugs by default | `9` | Native entry creation in `src/codex/catalog/sync.ts` |
| Unselected native models while a featured list exists | At least `featured.length + 100` | Native catalog merge in `src/codex/catalog/sync.ts` |

The management API limits `subagentModels` to five entries with `slice(0, 5)` in
`src/server/management/agent-settings-routes.ts`. This matches the Codex `spawn_agent` surface, which
advertises only the first five model overrides. Models outside those five can still remain visible
in the main picker and callable by their exact id.

## How ties are ordered

All ordinary routed models have priority `5`, so they need a tie-breaker. Before catalog entries are
built, `gatherRoutedModels()` sorts the routed model list by provider name and then by model id, both
alphabetically (`src/codex/catalog/provider-fetch.ts`).

This means neither of these configuration details changes the final order:

- the declaration order of keys in the `providers` object;
- the order of ids in a provider's `models` array.

`orderForSubagents()` then uses a stable sort to move configured featured picks to the front in the
same order as `subagentModels`. Non-featured models keep the provider/id alphabetical relative order
established earlier (`src/codex/catalog/sync.ts`). The featured rank is also converted to
priorities `0` through `4` when entries are built, so Codex's priority sort preserves that leading
sequence.

## Visibility is separate from ordering

`selectedModels` and `disabledModels` decide which routed models are exposed; they are not ordering
controls. `filterCatalogVisibleModels()` converts both selections to `Set` lookups and filters the
gathered list without using the arrays as ranks (`src/codex/catalog/provider-fetch.ts`).

As a result, reordering `selectedModels` or `disabledModels` has no effect on picker position. It can
only change whether a model is included.

## Effective picker pattern

With a non-empty featured list, the resulting order is:

1. Models in the exact configured `subagentModels` order, with priorities `0` through `4`.
2. All remaining routed models, ordered alphabetically by provider and then model id, at priority `5`.
3. Unselected native models, pushed below the featured block during catalog merge.

Without `subagentModels`, routed models remain at priority `5`, native GPT entries use their normal
priority (normally `9` for entries built by opencodex), and the routed group remains provider/id
alphabetical.

## Example

Suppose `subagentModels` contains these five ids in this exact order:

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

The picker begins as follows:

| Picker position | Model | Priority | Why it appears there |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | First `subagentModels` selection |
| 2 | `opencode-go/glm-5.2` | `1` | Second selection, even though its provider sorts after `anthropic` |
| 3 | `anthropic/claude-opus-4-6` | `2` | Third selection |
| 4 | `gpt-5.6-sol` | `3` | Fourth selection |
| 5 | `gpt-5.6-terra` | `4` | Fifth selection |
| 6 | `anthropic/claude-fable-5` | `5` | First remaining routed id in provider/id alphabetical order |
| 7 onward | Remaining routed models | `5` | Provider alphabetically, then model id alphabetically |
| After routed models | Remaining native models | `featured.length + 100` or higher | Unselected natives are moved below the featured block |

The first five entries are the overrides advertised to `spawn_agent`; the rest continue in the
normal picker order.

## Changing the order

The only supported way to customize leading model order is to reorder `subagentModels`. You can do
that on the dashboard's **Sub-agents** page or in the opencodex configuration. The list accepts at
most five models, and its order is significant.

There is currently no general `modelOrder`, `providerOrder`, or priority-map setting in `OcxConfig`.
The supported ordering field is `subagentModels` (`src/types.ts:238-246`); `disabledModels` and each
provider's `selectedModels` are visibility fields (`src/types.ts:276-282` and
`src/types.ts:439-446`). To change the rest of the picker order would require a code-level behavior
change rather than a configuration edit.
