# Cycle 010 — Non-activating OpenAI Tier Foundation

## Objective and phase safety

Add reusable typed policy, pure migration projection, and native-catalog projection
without exposing `openai-multi` in registry, config, routing, CLI, management, or GUI.
After this cycle, user-visible behavior is byte-compatible with the baseline. Public
activation happens atomically in Cycle 020 with route-aware auth.

## File change map

### MODIFY `src/types.ts`

Add:

```ts
export type CodexAccountMode = "direct" | "pool";
export const OPENAI_PROVIDER_TIER_VERSION = 1;
```

Extend `OcxConfig` with `openaiProviderTierVersion?: 1`. Do not add
`codexAccountMode` to persisted `OcxProviderConfig`; built-in account ownership is
trusted code metadata, not user configuration.

Before: any forward Responses provider can consume the global pool.
After: the type vocabulary exists, but no current provider is assigned `pool` and no
runtime caller changes behavior in this cycle.

### NEW `src/providers/openai-tiers.ts`

Own these constants and pure functions:

```ts
export const OPENAI_DIRECT_PROVIDER_ID = "openai";
export const OPENAI_MULTI_PROVIDER_ID = "openai-multi";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";
export const LEGACY_CHATGPT_PROVIDER_ID = "chatgpt";

export function builtInCodexAccountMode(providerName: string): CodexAccountMode | undefined;
export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean;
export function projectOpenAiTierMigration(config: OcxConfig): { config: OcxConfig; changed: boolean; legacyPoolIntent: boolean };
```

Contracts:

- `builtInCodexAccountMode("openai")` is `direct`; `openai-multi` is `pool`;
  all other ids return `undefined`.
- `isCanonicalOpenAiForwardProvider` requires adapter `openai-responses`, auth mode
  `forward`, and normalized base exactly
  `https://chatgpt.com/backend-api/codex`.
- `projectOpenAiTierMigration` deep-clones the config and never writes disk.
- With marker absent, pool intent is true when `codexAccounts` is nonempty or
  `activeCodexAccountId` is set.
- It removes a canonical configured `chatgpt` row, maps a `chatgpt` default to
  `openai-multi` when pool intent is true and otherwise `openai`, seeds canonical
  Direct, seeds Multi only for pool intent, preserves provider insertion order for
  all non-legacy rows, sets marker 1, and copies no credential values.
- When pool intent is true and the legacy default is `openai`, it rewrites
  `defaultProvider` to `openai-multi`. This preserves the old pooled behavior. With no
  pool intent, an `openai` default remains Direct.
- With marker 1, it is a no-op. Deliberately removed Multi is never resurrected.

### MODIFY `src/codex/catalog.ts`

Export a pure, currently uncalled helper:

```ts
export function projectNativeModelsForOpenAiMulti(
  config: OcxConfig,
  provider: OcxProviderConfig,
  nativeSlugs?: readonly string[],
): CatalogModel[];
```

The default `nativeSlugs` value is a snapshot from `nativeOpenAiSlugs()`; tests inject
a fixed snapshot so native catalog drift cannot make them nondeterministic. Existing
native context and upstream reasoning metadata helpers build the rows. Output rows use
provider `openai-multi` and retain native context/modalities/efforts; provider context
caps are applied by the existing hint/cap path. The helper is read-only and performs
no network request. It does not call ChatGPT `/models` and never reads OpenAI API
registry metadata. `gatherRoutedModels` does not call it until Cycle 020.

## Explicitly unchanged in 010

- `src/providers/registry.ts`
- `src/providers/derive.ts`
- `src/router.ts`
- `src/config.ts::loadConfig` and `src/server/index.ts::startServer`
- `src/codex/auth-context.ts`, HTTP, WS, compact, management, CLI, and GUI

This exclusion is the phase-safety gate: no selectable Multi row can exist while auth
is still route-blind.

## Tests

### NEW `tests/openai-provider-tiers.test.ts`

- exact id/mode constants;
- canonical forward shape accepts one exact transport and rejects changed adapter,
  auth mode, base, and trailing path;
- current registry/presets/config still expose no `openai-multi` after Cycle 010.

### NEW `tests/openai-provider-tier-migration.test.ts`

Drive the pure projection with fixtures for fresh config, no-pool legacy config,
added-account pool, explicit main id, legacy `chatgpt` default, custom default,
marker 1, removed Multi, provider ordering, and redacted sentinel credentials.
The added-account and explicit-main fixtures both start with
`defaultProvider: "openai"` and assert projected Multi default; a second projection
asserts marker-1 idempotence.
Assert input objects remain byte-identical and projected configs contain no copied
tokens/API keys beyond their original owner fields.

### MODIFY `tests/codex-catalog.test.ts`

Call the helper with an injected fixed native-slug snapshot and prove namespaced ids,
native-source metadata, provider caps, and API-metadata isolation. Also prove normal
`gatherRoutedModels` still emits no Multi rows in this cycle.

## Verification and acceptance

```sh
bun test tests/openai-provider-tiers.test.ts tests/openai-provider-tier-migration.test.ts tests/codex-catalog.test.ts
bun x tsc --noEmit
```

Accept only when all pure contracts pass and a catalog/preset snapshot proves no
user-visible Multi activation. Rollback is deletion of the new module/tests and the
two additive type members; no config has been persisted.
