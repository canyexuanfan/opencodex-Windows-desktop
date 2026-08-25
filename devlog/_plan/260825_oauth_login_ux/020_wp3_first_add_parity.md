# 020 — WP3: the login hint renders during a first add

**Issue:** bug report. **PR base:** WP2's head branch (stacked). **Screenshot:** required.

## The defect

Pain point 1, verbatim: *"이미 프로바이더가 추가된 상태에서는 링크를 복사할 수
있지만 → 첫 추가 때 못함."*

The hint is computed and stored. `use-providers-oauth.ts:93-96` reads
`url`, `instructions`, and `deviceCode` and calls `setLoginInfo`.
`Providers.tsx:365` passes `loginInfo` into `ProviderDetails`, which passes
it to `ProviderAuthPanel` — the workspace surface for a provider that already
exists.

During a first add there is no such provider. The modal is open, the panel is
not mounted, and `ProviderCatalog.tsx:205` renders
`t("prov.waitingBrowser")` with a Cancel button. The URL exists in React
state and has no renderer.

That is the whole bug. It is not "the modal cannot show a link" — it is
"nobody asked it to."

## The change

### 1. `ProviderCatalog.tsx` accepts and renders the hint

```diff
 export default function ProviderCatalog({
   presets, usageRank, presetsLoading, initialTier,
   onSelectPreset, onSelectCustom,
   accountRows, accountStatus, busyProvider,
+  loginHint,
+  onSubmitLoginCode,
   onLogin, onCancelLogin, onLogout, onManage,
 }: {
+  /** Hint for the account row whose login is in flight; ignored for other rows. */
+  loginHint?: { provider: string; url?: string; instructions?: string; deviceCode?: string } | null;
+  onSubmitLoginCode?: (provider: string, input: string) => Promise<{ ok: boolean; error?: string }>;
```

Inside the account-row map (`:148-212`), when
`busyProvider === row.id && loginHint?.provider === row.id`, render the WP2
`<LoginHint>` **below** the row rather than inside its badge strip — the
strip is a horizontal flex of buttons and a URL block belongs on its own line.

The row is currently a `<div className="list-row">` with two children. It
becomes a wrapper with the row on top and the hint underneath, so the
non-busy layout is byte-identical.

### 2. Paste state lives in the modal, not the catalog

`ProviderCatalog` is presentational by contract (its own header comment says
so). The paste value, busy flag, and message belong in `AddProviderModal`,
which already owns exactly those fields in its reducer for the preset pane
(`manualCode`, `manualCodeBusy`, `manualCodeMsg`, `manualCodeOk`).

`AddProviderModal` passes them down; the catalog renders them. One reducer,
two panes, no duplicated state.

### 3. `Providers.tsx` threads the hint into the modal

`loginInfo` already lives in `Providers.tsx:39`. It is passed to
`ProvidersPageModals` alongside `addModalAccountRows` and
`accountLoginStatus`, which the modal already receives. One more prop.

### 4. Cancel already works

`onCancelLogin` is wired at `ProviderCatalog.tsx:200-204` and hits
`cancelLoginFlow`. No change.

## What this phase must not do

- **Do not** move `loginInfo` into a context or a store. One prop, one hop.
- **Do not** change `ProviderAuthPanel`. WP2 already reworked it; this phase
  only teaches a second surface to render the same component.
- **Do not** auto-open the modal to a provider's workspace on login start.
  `onLoginSettled` already does that on success, and doing it earlier would
  unmount the modal mid-login — which is a longer way of reintroducing this
  exact bug.

## Test

`tests/oauth-first-add-hint.test.ts` (new): a pure-function test over the
row-visibility predicate extracted from the JSX, asserting that a hint renders
only for the row whose provider matches and only while that provider is busy.
Extract it as `shouldShowLoginHint(row, busyProvider, hint)` in
`provider-presets.ts` so it is testable without a DOM.

The cross-provider case is the one that matters: a hint for `anthropic` must
never render on the `xai` row, which is the same class of leak the
`oauthUrlProvider` tag guards against in the preset pane.

## Acceptance

- Starting a login for a not-yet-added provider from the Accounts tab shows
  the URL with a copy button, the device code when the provider sends one, a
  paste input, and Cancel — without leaving the modal.
- The link can be copied and opened in a different browser profile.
- `bun run typecheck`, `bun run test`, `bun run lint:gui` green.
- Screenshot of a first-add waiting state showing the copyable link.
