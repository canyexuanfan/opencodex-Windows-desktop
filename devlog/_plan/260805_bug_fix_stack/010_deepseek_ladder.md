# 010 — Layer 1: DeepSeek reasoning ladder (#1057)

## The defect

`src/providers/registry.ts:349-360` advertises `["high","xhigh","max"]` for both
DeepSeek V4 models and maps `low -> high`. Native `low` is therefore unreachable,
and `xhigh` is presented as a native tier while aliasing something else.

## What the vendor actually documents

From `001`, confirmed in both the English and Chinese official tables:

| requested | `deepseek-v4-flash` | `deepseek-v4-pro` |
|---|---|---|
| `low` | `low` | `high` |
| `high` | `high` | `high` |
| `xhigh` | `high` | `max` |
| `max` | `max` | `max` |

**The two models do not share a mapping.** The current code applies one
`DEEPSEEK_THINKING_REASONING_MAP` to both, so no single corrected constant is
right for both models.

## Change map

### `src/providers/registry.ts:349-360` — MODIFY

Replace the one shared map with the advertised ladder plus two per-model maps.

```ts
// BEFORE
const DEEPSEEK_THINKING_EFFORTS = ["high", "xhigh", "max"];
const DEEPSEEK_THINKING_REASONING_MAP: Record<string, string> = {
  low: "high", medium: "high", high: "high", xhigh: "max", max: "max",
};

// AFTER
// DeepSeek's Codex ladder is low/high/max (api-docs.deepseek.com/guides/thinking_mode,
// verified 2026-08-06). `xhigh` is a compatibility alias, not a native tier, and it
// resolves DIFFERENTLY per model: xhigh->max on Pro, xhigh->high on Flash. `medium`
// has no documented row; mapping it to `high` is our own compatibility choice.
const DEEPSEEK_THINKING_EFFORTS = ["low", "high", "max"];
const DEEPSEEK_PRO_REASONING_MAP: Record<string, string> = {
  low: "high", medium: "high", high: "high", xhigh: "max", max: "max",
};
const DEEPSEEK_FLASH_REASONING_MAP: Record<string, string> = {
  low: "low", medium: "high", high: "high", xhigh: "high", max: "max",
};
```

Note what does *not* change: Pro's `low -> high` stays, because that is what
DeepSeek does. The reporter asked for `low -> low` universally; that is correct
for Flash and wrong for Pro. Advertising `low` is right for both — the ladder is
what the picker shows — but the wire resolution differs, and we follow the vendor.

### The seven consumers — MODIFY each to pick the right map

`DEEPSEEK_THINKING_REASONING_MAP` is consumed by seven provider entries. Each
becomes a per-model selection instead of one shared object:

| provider | line | models |
|---|---|---|
| `opencode-go` | 934-950 | both |
| `orcarouter` | 1088-1093 | `deepseek/deepseek-v4-pro` |
| `deepseek` | 1185-1186 | both |
| `volcengine-coding-plan` | 1460-1478 | both |
| `alibaba-token-plan` | 1519-1524 | pro only |
| `alibaba-token-plan-intl` | 1552-1562 | both |
| `opencode-free` | 1668-1669 | `deepseek-v4-flash-free` → Flash map |

A small helper keeps this from becoming seven hand-written objects:

```ts
const deepseekReasoningMapFor = (modelId: string): Record<string, string> =>
  modelId.includes("flash") ? DEEPSEEK_FLASH_REASONING_MAP : DEEPSEEK_PRO_REASONING_MAP;
```

### `src/config.ts` — MODIFY (saved-config migration)

A constants-only patch fixes fresh installs only. CLI-created built-in providers
persist the full registry seed (`src/cli/provider.ts:168-179`,
`src/providers/derive.ts:135-140`), and a persisted per-model ladder *replaces*
the registry ladder at routing (`src/router.ts:162-170`). An existing user keeps
advertising `xhigh` and mapping `low -> high` forever.

Narrow in-memory normalizer during `loadConfig`, no write from the read path
(matching `src/config.ts:1509-1516`):

- Replace the exact legacy ladder `["high","xhigh","max"]` with `["low","high","max"]`.
- Replace the exact legacy map only; leave any non-exact user override untouched.
- Apply only where provider name and transport match the registry entry.

### Tests

**Update (these lock the defect):**

- `tests/provider-registry-parity.test.ts:110-113` — advertised ladder.
- `tests/volcengine-providers.test.ts:71-78` — advertised ladder + `low` mapping.

**Do not touch (these lock compatibility aliases, not the defect):**

- `tests/volcengine-providers.test.ts:261-264` — `medium -> high`, `xhigh -> max`.
- `tests/opencode-go-deepseek.test.ts:102-110` — same.
- `tests/umans-provider.test.ts:81-82` — Umans GLM, unrelated literal match.
- `tests/alibaba-intl-token-plan.test.ts:57-64` — Qwen 3.8, unrelated.
- `tests/reasoning-effort.test.ts:723-734` — generic self-heal fixture.

**Add:** a per-model assertion that Flash maps `xhigh -> high` while Pro maps
`xhigh -> max`, and a config-migration test for the legacy ladder.

## Red-green

The new per-model test fails on the pre-fix tree because both models currently
share one map. Ablating the Flash map alone flips that single assertion.

## Accept criteria

- Advertised ladder is `["low","high","max"]` for every DeepSeek V4 entry.
- Flash and Pro carry different wire maps, matching the vendor table.
- A saved legacy config normalizes on load; a customized one does not.
- `bun run typecheck` clean; the five affected test files pass.
