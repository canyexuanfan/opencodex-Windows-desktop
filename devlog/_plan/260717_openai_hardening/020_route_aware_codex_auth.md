# Cycle 020 — Atomic Three-tier Activation and Route-aware Auth

## Objective

Activate Direct, Multi, and API in one cycle together with all auth, migration,
catalog, management, HTTP, WebSocket, compact, and legacy-`chatgpt` boundaries. The
cycle may not close with any public tier still using route-blind auth.

## Registry, derivation, and routing

### MODIFY `src/providers/registry.ts`

- Add `codexAccountMode?: CodexAccountMode` to `ProviderRegistryEntry` only.
  `ProviderConfigSeed` remains a persisted-config shape and must not contain mode.
- `openai`: label `Codex Direct`, canonical forward transport, mode `direct`, featured.
- NEW adjacent row `openai-multi`: label `Codex Multi-account`, same transport,
  mode `pool`, featured, note “main + added accounts”.
- Rename `openai-apikey` label to `OpenAI API`; id/auth stay compatible.

### MODIFY `src/providers/derive.ts`

Derive preset/init display metadata directly from `ProviderRegistryEntry`, including
account mode, without cloning mode into `OcxProviderConfig` or `ProviderConfigSeed`.
Replace the blanket forward init label with registry labels. Safe public DTOs may
derive mode from the registry; persisted provider rows never contain it.

### MODIFY `src/router.ts`

- Extend `RouteResult` with top-level
  `codexAccountMode?: CodexAccountMode`; `routedProviderConfig` never writes mode into
  the provider config object.
- Before any configured namespace lookup, reject namespace `chatgpt` with the normal
  unknown-provider error, even when a legacy configured row exists.
- Then resolve enabled configured namespaces and attach registry-owned runtime mode.
- Before the generic configured-provider `defaultModel` loop, recognize a bare
  OpenAI-family model and try fixed enabled tier order `openai`, `openai-multi`,
  `openai-apikey`. This prevents `openai-apikey.defaultModel=gpt-5.5` or object
  insertion order from capturing a bare OpenAI id while Direct is enabled.
- The later generic `defaultModel` loop skips all three OpenAI tiers for a bare
  OpenAI-family request. Existing known-pattern, configured-model, and default-provider
  branches then retain their current relative order.
- Exclude legacy `chatgpt` from `activeProviderEntries`, known patterns, generic
  defaults, and configured-model candidates.

## Migration and legacy `chatgpt`

### MODIFY `src/config.ts`

- Add schema support for marker 1.
- Add `backupConfigBeforeOpenAiTierMigration()` which is a no-op when the original
  config file does not exist. Otherwise it writes bytes to a sibling temporary file,
  applies POSIX mode 0600 or existing `hardenSecretPath` Windows ACL handling, and
  atomically publishes `<configPath>.pre-openai-tiers-v1.bak` without overwriting an
  existing backup.
- Give the backup helper an injected IO seam covering read, exclusive temp creation,
  write, chmod/ACL, atomic publication, truncate, and unlink. The production
  `publishNoReplace(temp, backup)` implementation uses a same-directory hard link
  (`link(temp, backup)`), which atomically fails with `EEXIST` instead of replacing a
  destination; it then unlinks the temp. A prior destination-existence check is only
  an optimization and never the no-replace guarantee.
- The helper tracks `published = false`. Before publication, a failure may scrub the
  temp to zero bytes and retry unlink because no backup hard link exists. After
  `publishNoReplace` succeeds it sets `published = true`; from that point it never
  truncates the temp while the backup link exists because both paths share one inode.
- Post-publication cleanup first retries temp unlink directly. On permanent temp-unlink
  failure it attempts to unlink the newly published backup link (rollback). Only after
  rollback succeeds may it truncate/remove the remaining temp, and startup still
  aborts with `OpenAiTierBackupCleanupError` without saving the migration. If backup
  rollback also fails, it preserves both hardened links and their complete original
  bytes and aborts with `OpenAiTierBackupRollbackError`; it never continues migration
  or truncates either path. It never delegates secret-temp ownership implicitly to the
  normal config writer.
- Harden `atomicWriteFile`: on write/chmod/rename failure, unlink its temporary file
  in a `finally`/best-effort cleanup and rethrow. The original file remains intact.

### MODIFY `src/server/index.ts::startServer`

Immediately after `loadConfig()` and before `applyProxyEnv()`:

1. run `projectOpenAiTierMigration`;
2. when changed, create the one-time backup then `saveConfig(projected.config)`;
3. continue startup with the projected config;
4. remove the existing unconditional `upsertOAuthProvider(config, "chatgpt")` block.

Save failure aborts startup. The atomic writer leaves the original config intact;
the backup is the explicit downgrade path. Restoring the backup is documented in 050.
When `legacyPoolIntent` is true and the persisted `defaultProvider` is `openai`, the
projection explicitly changes it to `openai-multi`; without pool intent it stays
Direct. A fresh install has no original file to back up and still persists normally.

### MODIFY `src/oauth/index.ts`

Retain `OAUTH_PROVIDERS.chatgpt` and `runLogin("chatgpt")` as legacy credential
compatibility, but:

- `listOAuthProviders()` filters out `chatgpt` from GUI/public provider discovery;
- `runLogin` saves the credential but skips `upsertOAuthProvider` for `chatgpt`;
- `upsertOAuthProvider` refuses `chatgpt` so no future caller recreates a fourth tier.

Credential records are not deleted or copied. Direct uses caller Codex headers;
Multi uses the Codex account store. The legacy OAuth record remains recoverable by
older CLI flows without becoming a route/card.

## Route-aware auth and transports

### MODIFY `src/codex/auth-context.ts`

`resolveCodexAuthContext(headers, config, mode)` requires mode. `direct` returns
main immediately before affinity/quota/cooldown/token code. `pool` runs existing
selection unchanged, including `MAIN_CODEX_ACCOUNT_ID` as `main-pool`.
`applyCodexAuthContextToProvider` requires both provider mode `pool` and a pool
context before injecting runtime credentials.

### MODIFY `src/server/responses.ts`

- After `routeModel`, resolve Codex auth only for forward Responses providers with
  `route.codexAccountMode`. API/OAuth routes never call pool resolution.
- Replace incoming `authContext`/`selectedForwardHeaders` options with
  `onCodexAuthContextResolved` for WS registry observation.
- Gate pool outcome recorders on provider mode `pool` plus pool/main-pool context.
- Direct logs provider `openai`; Multi uses privacy-safe account suffixes.
- `handleResponsesCompact` uses the same mode and removes the broad pool-error catch
  that falls back to raw headers. Cooldown=429, expired affinity=409, reauth=401.

### MODIFY `src/server/index.ts`

- WS upgrade stores only selected inbound forward headers; it resolves no account.
- Each response frame enters `handleResponses`, which routes first and reports the
  resolved auth context via callback to `updateCodexWebSocketAuthContext`.
- A Direct/API frame clears previous pool tracking; Multi adds current tracking.
- Startup quota prime runs only with enabled configured `openai-multi`.

### MODIFY `src/codex/websocket-registry.ts`

Keep existing map; cover transitions undefined→pool, pool→main/undefined, pool-a→pool-b.

### MODIFY `src/codex/catalog.ts`

`gatherRoutedModels` appends `projectNativeModelsForOpenAiMulti` only for configured,
enabled canonical Multi. Direct stays bare native; API metadata never feeds Multi.

## Management admission

### MODIFY `src/server/auth-cors.ts::providerManagementConfigError`

Before any strip/sanitize step, inspect raw own-properties and reject
`codexAccountMode`, virtual maps, headers, capability/pool fields, and other
registry-only fields with 400. Admit forward mode only when name is `openai` or
`openai-multi` and every submitted provider field equals the full trusted registry
seed. Reject `chatgpt`, partial rows, extra fields, and custom bases.

Change the validation boundary to accept raw input before narrowing:

```ts
providerManagementConfigError(name: unknown, provider: unknown): string | undefined
```

It first requires a plain-record provider and inspects raw own-properties, then
narrows to `OcxProviderConfig`. Full canonical-seed equality applies only to reserved
forward tiers `openai` and `openai-multi`; existing `openai-apikey` and custom-provider
admission rules remain unchanged.

### MODIFY `src/server/management-api.ts`

Keep the existing POST body contract `{ name, provider }`. Only when `name` is the
reserved forward tier `openai` or `openai-multi`, require `provider` to equal the full
immutable canonical config seed field-by-field before persistence. API-key and custom
providers continue through their existing admission rules. Do not strip forbidden
fields before validation and never persist mode. Safe DTO derives account mode and
note from registry metadata and exposes neither credentials nor virtual maps. The
existing modal continues submitting the full seed.

## Tests and activation proof

- MODIFY `tests/provider-registry-parity.test.ts`: three ids/presets/init labels.
- MODIFY `tests/router.test.ts`: reverse insertion order; configured
  `openai-apikey.defaultModel=gpt-5.5`; bare always Direct; explicit namespace selects
  Multi/API; `chatgpt/<model>` is rejected even when a configured legacy row exists;
  a deliberate global default still selects its namespaced tier only through the
  existing default-provider branch.
- MODIFY `tests/server-auth.test.ts`: canonical Multi POST=200; forged base/mode/map/
  headers/capabilities and `chatgpt` POST=400; each forbidden raw own-property=400;
  existing API-key/custom POSTs remain green; safe DTO.
- MODIFY `tests/openai-provider-tier-migration.test.ts`: startup call site, absent-file
  fresh-install backup no-op, atomic backup, POSIX mode, injected Windows ACL hardener,
  injected read/create/write/harden/publish failures; destination created between
  inspection and `publishNoReplace`; pre-publication cleanup failures; transient
  post-publication temp-unlink failure followed by direct retry; permanent temp-unlink
  failure followed by successful backup-link rollback then temp scrub; and permanent
  backup-link rollback failure. Assert no post-publication truncate occurs while the
  backup link exists. In the final branch both paths retain complete original bytes,
  startup aborts, and migration save is never called. Assert every branch's exact
  cleanup attempt, original preservation, and pre-existing-backup bytes;
  two restarts, save-failure original preservation, explicit legacy `openai` default
  to Multi, order, and credential checks.
- MODIFY `tests/codex-auth-context.test.ts`: Direct pool spies remain untouched;
  Multi selects main/added and errors honestly; API makes zero pool calls.
- MODIFY `tests/codex-main-rotation.test.ts`: main eligibility and outcome rotation.
- MODIFY `tests/codex-websocket-registry.test.ts`: sequential Direct→Multi→Direct and
  pool-a→pool-b frames.
- MODIFY `tests/server-auth.test.ts`: HTTP and compact header/error matrix.
- MODIFY `tests/codex-quota-prime.test.ts`: Direct/API/disabled Multi no prime;
  enabled Multi one prime.
- MODIFY `tests/codex-catalog.test.ts`: configured Multi projection activated.

## Verification and exit gate

```sh
bun test tests/openai-provider-tiers.test.ts tests/openai-provider-tier-migration.test.ts tests/provider-registry-parity.test.ts tests/router.test.ts tests/codex-catalog.test.ts tests/codex-auth-context.test.ts tests/codex-main-rotation.test.ts tests/codex-websocket-registry.test.ts tests/codex-quota-prime.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
```

After the cycle, test snapshots and one local mock smoke must prove: exactly three
public tiers; Direct never touches pool state; Multi includes main and added accounts;
API uses key auth; no configured/public/routable `chatgpt` remains.
