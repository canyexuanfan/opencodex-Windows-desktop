# Cycle 040 — Management and GUI Presentation

## Objective

Make every management/UI surface describe the same three tiers. Runtime sidecar
ownership is already activated and verified in Cycle 020.

## Management and GUI file map

### MODIFY `src/server/auth-cors.ts`

`safeConfigDTO` derives account mode/note for `openai` and `openai-multi`. It omits
migration marker, credentials, registry virtual maps, and max-input internals.

### MODIFY `src/server/management-api.ts`

Provider presets expose exactly Direct, Multi, API. `/api/providers` carries derived
mode. These are exactly three OpenAI presets alongside all existing non-OpenAI and
custom presets. `/api/models` keeps bare Direct, namespaced Multi, namespaced API/Pro.
Disable, context-cap, subagent, and injection APIs store selected ids, never wire ids.

### MODIFY `src/providers/derive.ts`

Extend `DerivedProviderPreset` with `provider?: OcxProviderConfig`. For the reserved
forward presets `openai` and `openai-multi`, `entryToPreset` sets `provider` to a deep
clone of `providerConfigSeed(entry)`. Other presets retain their existing shape. This
gives the modal the same immutable full canonical seed that management admission
compares, without exposing registry-only mode or virtual-model metadata.

### MODIFY `gui/src/provider-icons.ts`

Map `openai-multi` and `openai-apikey` to the OpenAI icon.

### MODIFY `gui/src/components/AddProviderModal.tsx`

Add derived mode to `Preset`. Render Direct badge, Multi badge, or API-key badge;
add optional `provider?: ProviderPayload` to `Preset`, then call
`buildProviderPostBody(preset, form)`. Submit its returned full `{ name, provider }`
body. No editable account-mode or virtual-map field exists; existing API-key/custom
provider submission contracts remain unchanged.

### MODIFY `gui/src/provider-payload.ts`

Keep `buildProviderPayload(form)` for API-key/custom form submission. Add pure
`buildProviderPostBody(preset, form): { name: string; provider: ProviderPayload }`.
When preset id is `openai` or `openai-multi`, it requires and deep-clones
`preset.provider`; otherwise it uses `buildProviderPayload(form)`. It never copies
derived display-only mode/note fields. `AddProviderModal` uses this helper as the sole
POST body constructor.

### MODIFY `tests/provider-payload.test.ts`

Import the exact helper used by the modal. Use `deriveProviderPresets()` fixtures and
deep-equal Direct and Multi bodies against `providerConfigSeed()` for their registry
entries. Assert no mode/note or virtual field is posted, and retain existing API-key/
custom payload cases. In the required Cycle-040 browser run, inspect the management
POST network request and deep-compare its JSON to the same expected Direct/Multi body
before accepting the screenshot.

### MODIFY `gui/src/pages/Providers.tsx`

Type/read `codexAccountMode`; render localized Direct “main login, no rotation,”
Multi “main + added accounts,” and API “API key” badges. Multi links to Codex Auth;
Direct never nests global pool accounts.

### MODIFY `gui/src/pages/CodexAuth.tsx`

Copy states that this page owns Multi. When Multi is absent, render an add-provider
link while preserving account rows. Main remains visible as an eligible account.

### MODIFY `gui/src/pages/Models.tsx`

Use existing provider grouping. Render Multi and API/Pro selected ids; no wire-id UI.

### MODIFY `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`,
`gui/src/i18n/de.ts`, and `gui/src/i18n/zh.ts`

Add the same new keys to all four locale modules. `en.ts` remains `TKey` SoT;
`index.ts` and `shared.ts` require no translation-key edits.

## Sidecar dependency

Central sidecar ownership, standalone/internal caller rewiring, auth-aware fallback,
and the full activation matrix moved into Cycle 020 because route-aware auth cannot be
made mandatory atomically while route-blind sidecar callers remain. Cycle 040 only
updates management/GUI presentation and may refine labels; it does not re-own runtime
selection.

## Automated activation matrix

### MODIFY `tests/server-auth.test.ts`

Assert exact preset/DTO/card data and that registry-only fields never round-trip.

## Render-grounded GUI QA

Run a temporary proxy with deterministic temp `OPENCODEX_HOME` config containing the
three tiers and mock upstream URLs. Build/serve GUI, then use the native in-app browser.

Required runs:

1. English 1280×720: `/providers`; open Add Provider; verify three OpenAI choices,
   badges, Multi→Codex Accounts navigation; re-snapshot and inspect console.
2. Korean 1280×720: `/providers`; verify translated cards and API-key empty state.
3. English 1280×720: `/models`; verify bare Direct, namespaced Multi, API group, and
   three Pro rows; toggle one Pro row and re-snapshot.
4. Korean 390×844: `/codex-auth`; verify main row, Multi ownership copy, absent-Multi
   add action, and no horizontal overflow.
5. Stop management API once to observe the existing load-error state, restart it,
   and prove recovery on refresh.

Persist observed screenshots:

- `devlog/_plan/260717_openai_hardening/evidence/040_providers_en_1280x720.png`
- `.../040_providers_ko_1280x720.png`
- `.../040_models_en_1280x720.png`
- `.../040_codex_auth_ko_390x844.png`

## Verification and exit gate

```sh
bun test tests/server-auth.test.ts tests/provider-payload.test.ts
bun x tsc --noEmit
cd gui && bun run lint:i18n && bun run build
```

Exit requires management/payload tests plus one clean post-interaction DOM/
console observation for each named screenshot. Browser output produced but not read is
not evidence.
