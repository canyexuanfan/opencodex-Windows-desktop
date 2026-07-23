# 040 — Phase 4: extract from `gui/src/pages/Providers.tsx` (1426)

GUI surface, independent of all src/ work. `Providers.tsx` is imported only by
`gui/src/App.tsx:3` (rendered `:333`) — the default export `Providers` stays
at this path. Extraction targets: account/key-pool state hook, OAuth panel,
provider card list, JSON-editor hook.

## Shared refs (the coupling to respect)

- `aliveRef` `:95` — shared across OAuth/config/account/quota async flows.
  Stays in the page; passed INTO extracted hooks/components.
- `oauthLoginGenerationRef` `:101` — coordinates OAuth cancellation/generation
  validity (`:546-666`). Stays in the page (OAuth flow owner).
- `accountRequestGenerationRef` `:98` + `switchingAccountRef` — guard stale
  account responses (`:259-287`). Move WITH the account/key-pool hook.
- `jsonEditorOpenRef` `:96` — shared between JSON save/close and navigation/
  hash behavior (`:482-544`). Move WITH the JSON-editor hook.

## File map

### NEW `gui/src/hooks/useProviderAccountPools.ts` — account/key-pool state hook

Moves state/refs `:67-73` (accountSets, accountLoadStates, switchingAccount,
openAccounts, keyPools, addingKeyFor, newKeyValue, + generation refs `:98`),
the account/key-pool callbacks `:259-426` (fetchAccountSets, fetchKeyPools,
switchAccount, switchApiKey, removeApiKey, addApiKeyValue, addApiKey,
editCredentialAlias, removeAccount), and the derived provider-list effects
`:442-480` (oauthCardProviders, keyCardProviders, activeAccountNeedsReauth
`:465-473`).

Hook signature (inputs → returns), per inventory:

- Inputs: `apiBase`, `t`, `notify`, `fetchOauth`, `fetchConfig`,
  `fetchProviderQuotas`, `aliveRef`.
- Returns: `accountSets`, `accountLoadStates`, `switchingAccount`,
  `openAccounts`, `keyPools`, `addingKeyFor`, `newKeyValue`,
  `oauthCardProviders`, `keyCardProviders`, `activeAccountNeedsReauth`,
  `fetchAccountSets`, `fetchKeyPools`, `switchAccount`, `switchApiKey`,
  `removeApiKey`, `addApiKeyValue`, `addApiKey`, `editCredentialAlias`,
  `removeAccount`, setters for `openAccounts`/`addingKeyFor`/`newKeyValue`.

### NEW `gui/src/components/providers/OAuthPanel.tsx` — OAuth panel/rows

Moves JSX `:1043-1165`. Props (from inventory): `t`, `oauthProviders`,
`keyProviders`, `oauthStatus`, `busy`, `loginInfo`, `linkCopied`,
`deviceCodeCopied`, `manualCode`, `manualCodeBusy`, `manualCodeMsg`, the
key-provider view model, `setAdding`, `setLinkCopied`, `setDeviceCodeCopied`,
`setManualCode`, `requestLoginOAuth`, `cancelLoginOAuth`, `logoutOAuth`,
`submitManualCode`, plus `providerIconSrc`/`oauthLabel`/icons.

### NEW `gui/src/components/providers/ProviderCardList.tsx` — provider card/list

Moves JSX `:1175-1383`. Props (from inventory): `config`, `quotaReports`,
`accountSets`, `keyPools`, `openAccounts`, `addingKeyFor`, `newKeyValue`,
`busy`, `modeBusy`, `activeAccountNeedsReauth`, `t`, setters for
`openAccounts`/`addingKeyFor`/`newKeyValue`, `loginOAuth`,
`setOpenAiAccountMode`, `setProviderDisabled`, `removeProvider`,
`switchAccount`, `switchApiKey`, `removeAccount`, `removeApiKey`,
`requestLoginOAuth`, `addApiKey`, `resolvedOpenAiAccountMode`,
`oauthAccountDisplayLabel`, `providerIconSrc`, `QuotaBars`, icons.

### NEW `gui/src/hooks/useJsonConfigEditor.ts` — JSON editor mode

Moves state `:51,53,85-88` (editing, draft, jsonEditorOpen, jsonBaseline,
jsonSaving, jsonLeaveOpen), ref `:96` (jsonEditorOpenRef), and logic
`:482-544` (saveConfig, openJsonEditor, discardJsonEditor,
requestCloseJsonEditor, restoreJsonEditor, jsonIsDirty). The header/editor
JSX `:1018-1040` and textarea branch `:1167-1173` stay inline in the page but
consume the hook's returns (they are tightly woven into the page header
layout; extracting them is optional and out of scope if it forces layout
churn).

### MODIFY `gui/src/pages/Providers.tsx` — orchestrator

Keeps: page-level state not owned by the hooks above, OAuth flow callbacks
`:546-666` (loginOAuth, requestLoginOAuth, cancelLoginOAuth, logoutOAuth,
submitManualCode — they refresh account sets/OAuth status/config/quotas
`:703-717`, so they stay at the page and are passed down), modal
orchestration `:872-998,1384-1423`, provider mutation callbacks
`:723-828` (removeProvider, setProviderDisabled, updateProvider,
setOpenAiAccountMode). Composes the two hooks + two components. Target
< ~800 lines.

## Extraction risks (must hold in B)

- `loginOAuth` is used by the OAuth panel, provider cards, account rows, and
  modal orchestration (`:566-666,1251-1255,1308-1316`) — it stays in the page
  and is threaded as a prop; do NOT move it into a child.
- OAuth callbacks cross concerns (refresh account sets + OAuth status + config
  + quotas + model-refresh `:703-717`) — page-level, passed down.
- Generation refs move with their owning hook; `aliveRef` stays page-level and
  is injected.

## Verification (C) — includes render grounding (C-RENDER-GROUNDING-01)

1. `bun run typecheck`; `bun run test`; `bun run privacy:scan`.
2. `bun run lint:gui` and `bun run build:gui` green (c5).
3. Render grounding: build + serve the GUI (or `vite preview`), open the
   Providers page in a headless browser at 1280x720, screenshot, and READ it
   back — confirm the OAuth panel, provider cards, and JSON editor header
   render as before; drive one interactive state change (open the JSON editor
   or toggle a provider) and re-screenshot. Persist the screenshot to the
   devlog (C4-class surface).
4. Import-surface check: only `gui/src/App.tsx` imports `Providers`; new
   components/hooks are imported only by `Providers.tsx`.
5. `wc -l gui/src/pages/Providers.tsx` < 800.

## SoT sync

Note the new `gui/src/components/providers/` + `gui/src/hooks/` layout in D
(GUI has no `structure/` note today; recommend one if GUI work continues).
