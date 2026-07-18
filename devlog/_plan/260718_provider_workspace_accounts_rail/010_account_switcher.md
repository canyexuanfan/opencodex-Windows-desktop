# Work phase 010 — workspace account tab

## Outcome

Expose the already implemented generic OAuth, API-key, and canonical Codex account managers as a first-class, accessible workspace detail tab. Make account list/switch state authoritative under failure and concurrent refresh.

## Scope boundary

### IN

- `gui/src/pages/Providers.tsx`
- `gui/src/provider-workspace/auth.ts` (new pure auth-surface owner)
- `gui/src/components/provider-workspace/types.ts`
- `gui/src/components/provider-workspace/ProviderDetails.tsx`
- `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- `gui/src/components/CodexAccountPool.tsx`
- `gui/src/styles/provider-workspace-settings.css`
- `gui/src/i18n/{en,ko,de,zh}.ts`
- `tests/provider-workspace-auth.test.ts` (new)
- existing OAuth/Codex API and workspace tests

### OUT

- Server account routes/stores unless a failing contract test proves a server defect.
- Provider deletion behavior, automatic switching policy, quota algorithms, login protocol internals, classic card redesign, or new dependencies.

## Exact diff plan

### NEW `gui/src/provider-workspace/auth.ts`

- Define a narrow `ProviderAuthSurface = "codex-accounts" | "oauth-accounts" | "api-keys" | null`.
- Implement `providerAuthSurface(item)` by reusing `isAccountProvider(item.name, item)` and `isLocalProvider(item)`.
- Canonical OpenAI forward maps to `codex-accounts`; non-canonical forward maps to `null`; OAuth maps to `oauth-accounts`; effective key-auth maps to `api-keys`; local/no-auth maps to `null`.
- No network/UI state belongs in this module.

### MODIFY `gui/src/components/provider-workspace/types.ts`

- Add `AccountLoadState = "idle" | "loading" | "ready" | "error"`.
- Extend `ProviderAuthHandlers` with optional retry and async-compatible return signatures without breaking existing callers.
- Keep wire rows credential-free; do not add raw token/account fields.

### MODIFY `gui/src/pages/Providers.tsx`

- Add per-provider account load state, per-provider request-generation refs, and `{ provider, accountId } | null` switching state.
- Replace the all-at-once `Object.fromEntries` account load with per-provider generation-bound commits and functional map merges so subset refresh cannot erase other providers.
- Check `response.ok`; map failure to `error`; never treat failed JSON as an empty successful account set.
- Wrap generic account switch in `try/catch/finally`, block duplicate switches, reject `needsReauth`, and preserve the old visible active row until the authoritative list reload succeeds.
- On success refresh only the switched provider account set, OAuth status, and forced quota. On failure leave selection untouched and surface localized retryable status.
- Extract the API-key request into `(provider, key) => Promise<boolean>` and keep classic `newKeyValue` state in its wrapper.
- Pass `oauth`, `accounts`, `keys`, load state, switching id, busy/login hint, and existing handlers into workspace `ProviderDetails`.
- Keep account handler object stable via direct object construction or memoization only if measured; do not create a global store.

### MODIFY `gui/src/components/provider-workspace/ProviderDetails.tsx`

- Extend `Tab` with `accounts`.
- Derive the auth surface once and insert a dynamic tab: `Accounts` for Codex/OAuth, `API keys` for key-auth. Omit it for no-op surfaces.
- Move `ProviderAuthPanel` out of Settings and render it only in the new panel.
- Add stable tab/panel ids, `aria-controls`, `aria-labelledby`, roving `tabIndex`, and ArrowLeft/ArrowRight/Home/End activation.
- If provider data changes and the current tab no longer exists, return to Overview without an effect-synchronized derived state.
- Preserve the unsaved-Settings leave confirmation when moving to Accounts.

### MODIFY `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

- Use `providerAuthSurface`; embed `CodexAccountPool` only for `codex-accounts`.
- Render loading, load-error + retry, loaded-empty, one, many, reauth, and switching states with text and ARIA status, not color alone.
- Do not describe a one-row identity-less provider as a multi-account pool. The panel may show the current login and re-login action while the actual returned account count remains one.
- Keep active rows focusable and expose `aria-current`/selected text rather than disabling the active row.
- Disable mutation on pending or `needsReauth` rows; expose a recovery/add-account action.
- Replace `account.email ?? account.id` with masked email or localized ordinal fallback; titles/aria labels follow the same safe label.
- Give remove buttons translated accessible names and preserve the separate-button structure.

### MODIFY `gui/src/components/CodexAccountPool.tsx`

- Add initial/refresh load state, request generation, and switching id.
- Require both list and active responses to be `ok`; ignore superseded loads.
- For active PUT, check non-2xx, keep the old active state on failure, announce the error, and on success consume the returned active id then perform an authoritative refresh.
- Prevent interval refresh from overwriting a newer switch; keep the documented “next session” semantics.
- Do not change add/remove/reset-credit or auto-switch business rules.

### MODIFY `gui/src/styles/provider-workspace-settings.css`

- Add account panel/loading/error/empty/switching styles using existing spacing, type, color, radius, and motion tokens only.
- Ensure email/labels use `min-width:0`, ellipsis, and title; actions remain reachable at mobile touch size.
- Add visible focus and pending treatment without changing layout dimensions.

### MODIFY locale files

- Add `pws.tab.accounts`, account loading/failure/retry/empty/switching/ordinal labels, and Codex load/switch failure copy in all four locale files.
- Korean uses short action-oriented B2B wording; buttons/tabs have no periods.

### NEW `tests/provider-workspace-auth.test.ts`

- RED before production edits: auth-surface tests for canonical OpenAI, custom forward, OAuth, key, optional/no-key, and local providers.
- Add source-contract assertions only for the integration seam that cannot be imported without a DOM harness: workspace passes account rows/state/handlers and ProviderDetails owns an Accounts panel. Do not replace browser behavior proof with source assertions.
- Classify all test edits as required; no skips, threshold changes, or assertion deletions.

## Activation matrix

| Branch | Trigger | Observable evidence |
|---|---|---|
| loading | delayed GET | loading status; controls absent/disabled |
| empty | 200 + empty list | explanatory empty state + login/add action |
| one | one active summary | one labeled current row; no raw id |
| many | Anthropic 2 / Codex 4 live rows | exactly one selected/current; others switchable |
| reauth | fixture `needsReauth=true` | visible warning; switch blocked; recovery action |
| HTTP failure | 404/500 PUT | old active row remains; alert; controls recover |
| network failure | rejected fetch | no unhandled rejection; old active remains |
| stale GET | old load resolves after switch refresh | generation guard drops old result |
| custom forward | noncanonical forward provider | no Codex pool/tab |
| keyboard tabs | Accounts tab with arrows/Home/End | focus and selected panel move together |
| live switch | switch non-active Anthropic/Codex account | network PUT, selected state changes after refresh, original id restored at teardown |

## Verification

```sh
bun test --isolate tests/provider-workspace-auth.test.ts tests/oauth-accounts-api.test.ts tests/oauth-store-multi.test.ts tests/oauth-public-surface.test.ts tests/codex-auth-api.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
bun run typecheck
cd gui && bun run lint:i18n
cd gui && bun run build
bun run privacy:scan
```

Browser evidence must cover generic OAuth and canonical Codex account panels, switch success/failure, refresh persistence, keyboard tabs, and restoration of the original live active IDs.
