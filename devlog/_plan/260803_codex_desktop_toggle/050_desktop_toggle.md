# WP6 — Claude Desktop toggle: pivot to standard mode, then remove credentials

Research: `002_desktop_standard_mode.md`. Read it first; this doc is the diff.
The official contract is Anthropic's
[Claude Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
(last modified 2026-07-24), as captured with the other primary citations in `002`.

The concrete failure mode is a disable that deletes `<id>.json` while
`_meta.json.appliedId` still names that id: Desktop opens the selected file by id,
so the next launch points at something missing. The superseded `030` correctly
noticed that pointer hazard, but concluded that exact restoration of the previous
selection was required and therefore removal needed a durable operation-state
engine. That joined two different requirements. Exact restoration is still
impossible because apply overwrites `appliedId` without recording its previous
value (`src/claude/desktop-3p.ts:345-358`); returning to standard Claude is
documented and achievable. This phase writes and selects a present, readable,
credential-free `{}` profile first, then removes the old opencodex profile and
its credential-bearing backup. It does not add an operation-state engine.

## IN / OUT

IN:

- `src/claude/desktop-3p.ts` — MODIFY: add the standard-mode remover and make
  apply prefer the selected opencodex row when an interrupted cleanup left two.
- `src/cli/claude-desktop.ts` — MODIFY: explicit CLI apply is the enable
  direction and persists WP3 desired ON plus `desktopAutoApply: true` first.
- `src/server/management/agent-settings-routes.ts` — MODIFY: gate auto-apply on
  WP3 desired state, re-check after its await, expose desired state in `/status`,
  and make explicit `/apply` an enable action.
- `src/server/management/native-integration-routes.ts` — MODIFY: add
  `claude-desktop` status and `PUT` toggle using the existing typed
  success/refusal/single-flight pattern (`:31-86`, `:164-174`, `:371-445`).
- `gui/src/pages/integrations/native-api.ts` — MODIFY: carry the new native id,
  refusal reasons, and residual paths.
- `gui/src/pages/integrations/integration-api.ts` — MODIFY: parse Desktop desired
  state from the existing rich status route.
- `gui/src/pages/integrations/overview-clients.ts` — MODIFY: give
  `claudeDesktopRow` a toggle and keep desired switch state separate from observed
  `applied` state.
- `gui/src/pages/integrations/IntegrationsOverview.tsx` — MODIFY: route the toggle,
  select Desktop dialog copy, and render localized partial/refusal outcomes.
- `gui/src/pages/integrations/refusal-copy.ts` — MODIFY: translate Desktop's
  metadata refusal and incomplete credential cleanup.
- `gui/src/pages/ClaudeDesktop.tsx` — MODIFY: show desired OFF honestly and label
  Save + Apply as an enable action while OFF.
- `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` — MODIFY: exact keys below.
- `tests/desktop-3p-removal.test.ts` — NEW: filesystem and crash-boundary cases.
- `tests/native-claude-desktop-toggle.test.ts` — NEW: route, ordering, persistence,
  refusal, and auto-apply cases.
- `tests/claude-messages-endpoint.test.ts` — MODIFY: shared transport remains live.
- `gui/tests/integrations-overview-rows.test.ts` — MODIFY: desired/observed mapping.
- `gui/tests/integrations-surfaces.test.tsx` — MODIFY: switch, dialog, and outcome.
- `gui/tests/claude-desktop-locale.test.ts` — MODIFY: six-locale parity.

OUT:

- `src/types.ts` and `src/config.ts` — WP3 already owns
  `clientIntegrations["claude-desktop"]`, default-ON parsing,
  `clientIntegrationEnabled`, and `setClientIntegrationEnabled`. WP6 consumes
  those helpers and does not open-code the map (`020_desired_state.md:149-183`).
- `src/claude/desktop-3p-paths.ts` — path resolution is already one tested owner;
  the remover consumes `resolveDesktop3pConfigLibraryPath()` unchanged (`:67-78`).
- `src/claude/desktop-profile.ts` — assignments/defaults are preserved as-is; no
  new profile field is needed.
- `/v1/messages` and `src/server/claude-messages.ts` — shared transport is not a
  Desktop lifecycle switch. Claude Code must continue using it.
- `inferenceProvider: "anthropic"` — this means direct Claude API billing, not
  normal subscription mode, so it is not a disable fallback.
- A native Desktop "return to standard" button — UNPROVEN and not called.
- Recording the previous `appliedId` — explicitly deferred. It would enable exact
  restoration of another prior third-party selection, not standard-mode disable.
- The user's live Claude Desktop config library — no implementation or C-gate
  command mutates it without a separate, explicit approval.

## What we depend on and what we refuse to depend on

We depend on one official contract: third-party mode activates only when
`inferenceProvider` and that provider's required credentials are valid; otherwise
Desktop launches in standard mode. Desktop reads the configuration once at launch
([configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration),
`002:27-46`). Therefore `{}` is deliberate: valid JSON, no
`inferenceProvider`, no credential fields.

We refuse to depend on all four UNPROVEN behaviors:

1. absent `appliedId` being safe;
2. dangling `appliedId` being tolerated;
3. a `Default` entry being guaranteed;
4. a native "return to standard" UI action existing.

The algorithm never removes `appliedId`, never points it at an unreadable or
missing file, never chooses by `name === "Default"`, and never automates Desktop's
UI. The local evidence makes the third refusal load-bearing: this machine's real
`_meta.json` has a `Default` row whose `<id>.json` does not exist (`002:60-63`).

## Core diff — select a safe target before cleanup

MODIFY `src/claude/desktop-3p.ts`. Add `unlinkSync` to the existing fs import,
export the result vocabulary beside `Desktop3pConfigLibraryOptions`, and place the
remover after `writeDesktop3pConfig` and before `atomicReplaceDesktopConfig`:

```diff
-import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
+import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
@@
+export type Desktop3pRemoveReason =
+  | "unsafe_metadata"
+  | "write_failed"
+  | "cleanup_incomplete";
+
+export interface Desktop3pRemoveResult {
+  ok: boolean;
+  changed: boolean;
+  libraryPath: string;
+  standardProfilePath?: string;
+  reason?: Desktop3pRemoveReason;
+  message?: string;
+  residualPaths?: string[];
+}
+
+export interface Desktop3pRemoveDeps {
+  randomId?: typeof randomUUID;
+  writeFile?: typeof atomicWriteFile;
+  unlinkFile?: typeof unlinkSync;
+}
```

The function signature is fixed here, and it lives in
`src/claude/desktop-3p.ts` because `parseMetadata`, metadata ownership, atomic
writes, and profile-path construction already live there:

```ts
export function removeDesktop3pConfig(
  options: Desktop3pConfigLibraryOptions = {},
  deps: Desktop3pRemoveDeps = {},
): Desktop3pRemoveResult
```

`options` gives tests the same pure path seam used by
`resolveDesktop3pConfigLibraryPath`; `deps` gives failure tests deterministic ids,
atomic-write failure, and unlink failure without patching globals. Production
passes neither. The function does not accept or return credential values and
never logs profile contents.

The implementation is this ordered state machine, expressed against the current
writer:

```diff
 export function writeDesktop3pConfig(/* existing args */) {
@@
-    const existing = metadata.entries.find(entry => entry?.name === "opencodex" && typeof entry.id === "string");
+    // If disable was interrupted after selecting its replacement, reuse the
+    // selected opencodex row, not an older non-selected cleanup row.
+    const existing = metadata.entries.find(entry =>
+      entry?.name === "opencodex" && entry.id === metadata.appliedId
+    ) ?? metadata.entries.find(entry =>
+      entry?.name === "opencodex" && typeof entry.id === "string"
+    );
@@
 }
+
+export function removeDesktop3pConfig(
+  options: Desktop3pConfigLibraryOptions = {},
+  deps: Desktop3pRemoveDeps = {},
+): Desktop3pRemoveResult {
+  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
+  const metadataPath = join(libraryPath, "_meta.json");
+  const randomId = deps.randomId ?? randomUUID;
+  const writeFile = deps.writeFile ?? atomicWriteFile;
+  const unlinkFile = deps.unlinkFile ?? unlinkSync;
+  // 1. Parse and validate before the first Desktop-library write. A non-string
+  // id, path separator, duplicate non-selected opencodex row, or malformed
+  // entries array is unsafe_metadata: desired OFF is already persisted by the
+  // caller, but this function touches no Desktop bytes.
+
+  // 2a. If appliedId already selects an opencodex row whose file parses exactly
+  // as a credential-free object with no inferenceProvider, this is a retry.
+  // Reuse it; do not allocate another replacement.
+  // 2b. Otherwise allocate randomId(), atomically write "{}\n" to the fresh
+  // <id>.json, and verify it can be read and parsed before publishing the id.
+
+  // 3. Atomically write metadata with BOTH rows still present and appliedId set
+  // to the new standard row. From here on Desktop's selected id always resolves.
+
+  // 4. Remove the old <id>.json.bak FIRST, then old <id>.json through
+  // unlinkFile. Keep the old metadata row until both deletions succeed: it is
+  // the retry locator after a crash. Missing files count as already cleaned;
+  // no file content is printed.
+
+  // 5. Atomically remove the old metadata row LAST. Preserve every unrelated
+  // entry and every unknown top-level/entry field byte-semantically through
+  // object spreads, as writeDesktop3pConfig does today.
+
+  // Any failure after step 3 returns cleanup_incomplete plus residualPaths.
+  // appliedId remains on the readable standard profile; the caller does not
+  // clear appliedFingerprint/appliedAt until a retry completes steps 4-5.
+}
```

Path validation is deletion policy, not format cleanup. The old id must be one
path component: reject `/`, `\\`, `..`, NUL, or a resolved path outside
`libraryPath`. Multiple non-selected `name === "opencodex"` rows are ambiguous and
REFUSE `unsafe_metadata`; the function does not guess which user-visible row to
delete. A missing `_meta.json` is not unsafe: create the standard file and a new
metadata document with one selected opencodex row. A dangling `Default` row is
preserved untouched.

The standard file is exactly `{}` plus a newline. Do not send
`inferenceProvider: "anthropic"`; do not copy any old field into the replacement;
do not call `atomicReplaceDesktopConfig` for the fresh target, because that would
create another `.bak` the disable then has to explain.

## Persist intent before touching Desktop

WP3 provides desired state. Both CLI apply and the existing POST apply become
explicit enable actions:

```diff
 // src/cli/claude-desktop.ts:45-49
+import { loadConfig, saveConfigPreservingClaudeCode, setClientIntegrationEnabled } from "../config";
@@
   const config = loadConfig();
+  setClientIntegrationEnabled(config, "claude-desktop", true);
   const state = await buildClaudeDesktopState(config, profile);
-  config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
+  config.claudeCode = {
+    ...(config.claudeCode ?? {}),
+    desktopAutoApply: true,
+    desktopProfile: state.profile,
+  };
   saveConfigPreservingClaudeCode(config);
```

```diff
 // src/server/management/agent-settings-routes.ts:735-738
       const state = await buildClaudeDesktopState(config, profileOverride);
-      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
+      setClientIntegrationEnabled(config, "claude-desktop", true);
+      config.claudeCode = {
+        ...(config.claudeCode ?? {}),
+        desktopAutoApply: true,
+        desktopProfile: state.profile,
+      };
       saveConfigPreservingClaudeCode(config);
```

The disable endpoint follows `native-integration-routes.ts` rather than inventing
a second response grammar. Extend `NativeIntegrationClientId` with
`"claude-desktop"`, extend refusal reasons with `unsafe_metadata` and
`cleanup_incomplete`, add a module-level Desktop single-flight, include its status
in GET, and add `PUT /api/native-integrations/claude-desktop`:

```diff
-export type NativeIntegrationClientId = "claude" | "grok";
+export type NativeIntegrationClientId = "claude" | "claude-desktop" | "grok";
@@
 export type NativeRefusalReason =
   | "not_installed"
   | "orphaned_marker"
+  | "unsafe_metadata"
+  | "cleanup_incomplete"
   | "home_mismatch"
@@
 export interface NativeRefusalEnvelope {
@@
+  residualPaths?: string[];
 }
```

WP3 has already added `desiredEnabled` to `NativeStatus`,
`NativeToggleEnvelope`, and post-persist refusal envelopes
(`020_desired_state.md:423-453`). Desktop uses those fields; it does not add a
second desired-state property.

Disable body, in this exact order:

```ts
// PUT { enabled: false }
// 1. Persist BOTH suppressors before the Desktop mutation.
setClientIntegrationEnabled(config, "claude-desktop", false);
config.claudeCode = {
  ...(config.claudeCode ?? {}),
  desktopAutoApply: false,
};
persist(config);

// 2-3. Fresh readable standard profile -> appliedId pivot -> old .bak/.json/row.
const removed = removeDesktop3pConfig();
if (!removed.ok) {
  // unsafe_metadata: 409 refused; no Desktop bytes changed.
  // write_failed/cleanup_incomplete: 500 failed. For cleanup_incomplete include
  // residualPaths; desired OFF and auto-apply suppression remain persisted.
  return desktopRefusal(removed);
}

// 4. Only complete cleanup clears observed apply markers. Preserve the profile's
// assignments/defaults (33 assignments on this machine) and every other field.
const profile = config.claudeCode?.desktopProfile;
if (profile) {
  const { appliedFingerprint: _fingerprint, appliedAt: _appliedAt, ...preserved } = profile;
  config.claudeCode = { ...config.claudeCode, desktopProfile: preserved };
  persist(config);
}

return jsonResponse({
  ok: true,
  clientId: "claude-desktop",
  changed: removed.changed,
  state: "absent",
  reason: "desktop_standard_mode",
  message: "Claude Desktop is configured for standard mode; restart required",
});
```

The endpoint does not stop, restart, or reconfigure the proxy. Enable persists
desired `true` and `desktopAutoApply: true` first, then runs the same state build
and `writeDesktop3pConfig` path as POST apply, and finally records fingerprint/time.
If generation fails, desired ON remains visible while observed state remains off;
the response is a failure, not false green. No enable or disable branch touches
`config.claudeCode.enabled`, so Claude Code's use of `/v1/messages` is unchanged.

## Crash-safety: exact residual state at every boundary

There is no transaction across opencodex `config.json`, Desktop `_meta.json`, and
three profile paths. The ordering preserves a valid selected pointer; it does not
make the whole disable transactional.

| Process dies after | State on disk | Classification / retry |
|---|---|---|
| desired OFF + `desktopAutoApply:false`, before standard file | Desktop still selects the old gateway profile; automatic re-apply is suppressed | Pointer-safe only; disable is not effective. Retry starts the mutation. |
| standard `{}` file, before first metadata write | Old profile still selected; the fresh credential-free file is orphaned and its generated id was not durably recorded | Pointer-safe only; retry creates another fresh target. The harmless orphan may remain because identifying it after process death would require the operation record this design deliberately does not add. No claim of transactional cleanup or semantic disable. |
| metadata points to standard, before `.bak` deletion | Next Desktop launch is standard mode; old profile and backup still contain credentials | Pointer-safe and semantically disabled on next launch, but security cleanup is incomplete. Old metadata row locates both files for retry. |
| `.bak` deleted, before old `.json` deletion | Selected standard file exists; one old credential-bearing profile remains | Pointer-safe, not security-complete. Retry deletes the old profile. |
| old `.json` deleted, before old row removal | Selected standard file exists; stale non-selected row may name a missing file | Applied-pointer-safe, not registry-clean. Retry removes that exact old row. |
| old row removed, before markers clear | Desktop library and credential cleanup are complete; `/status` still derives `applied:true` from the stale fingerprint (`agent-settings-routes.ts:797-804`) | Runtime files are safe; bookkeeping is false. Retry clears markers without changing assignments/defaults. |
| markers clear | Desired OFF, auto-apply OFF, selected standard profile readable, old profile and `.bak` absent | Disable is complete on disk. A Desktop process already running can still be using launch-time state until restart. |

The first metadata write contains both rows and points at the new one. Cleanup
deletes the `.bak` first because it is an otherwise unmanaged credential copy,
then the old config, then its metadata row. Removing the row first would lose the
only crash-retry locator; deleting either file before the pointer pivot would
recreate the original dangling-selection bug.

## The `.bak` is a security obligation

`atomicReplaceDesktopConfig` copies the prior profile to `<id>.json.bak`
(`src/claude/desktop-3p.ts:371-380`), and the profile contains
`inferenceGatewayApiKey`. Nothing removes it today (`002:13-15`). A successful
disable MUST end with both old `<id>.json` and `<id>.json.bak` absent. A response
cannot say success when either remains: return `cleanup_incomplete`, include only
residual file paths, keep desired OFF, and keep the old metadata row as the retry
locator. Never include file contents, parsed credential fields, or credential
values in logs, errors, tests, screenshots, or the API envelope.

## Auto-apply suppression

The located automatic caller is `PUT /api/subagent-models`: after saving and two
other refreshes, it awaits `autoApplyDesktopBestEffort()`
(`agent-settings-routes.ts:518-528`). Its current guard checks only
`desktopAutoApply === false` before `fetchAllModels` (`:130-151`). Persisting OFF
first prevents later calls; a second check after the await closes the already
started in-process race:

```diff
 async function autoApplyDesktopBestEffort(): Promise<void> {
   try {
+    if (!clientIntegrationEnabled(config, "claude-desktop")) return;
     if (config.claudeCode?.desktopAutoApply === false) return;
     if (!config.claudeCode?.desktopProfile) return;
@@
     const allModels = await fetchAllModels(config);
     const routed = /* existing mapping */;
+    // The toggle can persist OFF while fetchAllModels was awaiting. Re-check
+    // immediately before the synchronous writer.
+    if (!clientIntegrationEnabled(config, "claude-desktop")) return;
+    if (config.claudeCode?.desktopAutoApply === false) return;
     const result = writeDesktop3pConfig(/* existing args */);
```

If auto-apply has already entered the synchronous writer, JavaScript completes
that write before the toggle handler runs; the later disable then pivots away and
cleans it. If it is awaiting model discovery, the second guard stops it. This is
in-process ordering, not a cross-process file lock; a second opencodex process is
INFERRED possible and is reported by post-write status, not claimed excluded.

Extend `/api/claude-desktop/status` without changing the existing observed fields:

```diff
 return jsonResponse({
+  enabled: clientIntegrationEnabled(config, "claude-desktop"),
   applied: savedFingerprint !== null,
@@
 });
```

Desired state drives the switch. `applied`, `stale`, and `activeProfile` remain
observed evidence and drive badge/count detail. A failed disable may therefore
show switch OFF with an amber observed-state notice; that is the truthful
"desired OFF, observed conflict" state required by WP3.

## GUI — one switch, one consequence dialog

`claudeDesktopRow` currently hard-codes `toggle: null`
(`gui/src/pages/integrations/overview-clients.ts:240-277`). Give it the native id
and a separate optional `toggleOn` so the summary count does not become desired
state by accident:

```diff
 export interface OverviewRow {
@@
   applied: boolean;
+  /** Desired switch position; absent means use observed `applied`. */
+  toggleOn?: boolean;
@@
 function claudeDesktopRow(
   payload: ClaudeDesktopPayload | null,
+  native: NativeStatus | undefined,
+  nativeSettled: boolean,
 ): OverviewRow {
@@
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
+    toggle: "claude-desktop",
+    toggleBlocked: native?.disableBlocked ?? null,
+    togglePath: native?.configPath ?? null,
+    toggleOn: native?.desiredEnabled ?? (payload?.enabled !== false),
```

`OverviewCard` renders `on={row.toggleOn ?? row.applied}`. The Desktop row is
unknown and non-actionable until both its rich status and native status settle.
Desired OFF + stale marker is amber, not green; desired ON + no applied marker is
absent with the switch ON and `integrations.detail.desktopDesiredOnNotApplied`.

Add `DESKTOP_DISABLE_COPY` beside `GROK_DISABLE_COPY` and branch on
`pendingToggle.id`. Exact English source copy:

> **Disable Claude Desktop integration?**
>
> `{path}` will be updated to select a new credential-free opencodex profile with
> no inference provider. The previous opencodex profile and its backup will be
> removed.
>
> Claude Desktop will stop using models routed through opencodex and return to
> standard Claude.
>
> Turning it back on regenerates the opencodex profile from your saved model
> assignments. It cannot restore whichever profile was selected before
> opencodex was first applied.
>
> **Claude Desktop reads this configuration only at launch. Fully quit and reopen
> Claude Desktop for this change to take effect.**

Confirm label: **Disable**. The restart sentence is `sideEffectKey`, not a toast
added after confirmation: the user sees the delayed effect before choosing.
There is no claim that the current Desktop process switched instantly.

The refusal/partial copy is equally exact:

- `unsafe_metadata` — "Claude Desktop's metadata could not be read safely, so
  its library was not changed. The requested Off state was saved and automatic
  apply remains disabled. Repair `{path}/_meta.json`, then try again."
- `config_busy` — reuse the existing native lock copy: nothing was persisted and
  retry is appropriate.
- `cleanup_incomplete` — "Claude Desktop is pointed at standard mode, but old
  opencodex credential files remain at: `{paths}`. Remove them manually before
  treating cleanup as complete." This is a failed partial outcome, not a refusal
  pretending nothing changed.
- `write_failed` before the pointer pivot — use the server message and say no
  Desktop library change completed; desired OFF remains saved if step 1 passed.

On the Desktop page, add `enabled` to `DesktopStatus`. When false, the status bar
says: "Claude Desktop integration is off. Desktop reads configuration only at
launch; if it was open during the change, fully quit and reopen it." Save remains
available because assignments/defaults are intentionally preserved; Save + Apply
reads **Enable and apply** and goes through the explicit enable path.

## i18n

Add every key to exactly these six locale files:

```
gui/src/i18n/en.ts
gui/src/i18n/ko.ts
gui/src/i18n/ja.ts
gui/src/i18n/zh.ts
gui/src/i18n/de.ts
gui/src/i18n/ru.ts
```

Exact keys (English is the source of truth / `TKey`):

```text
integrations.dialog.desktop.title
integrations.dialog.desktop.changes
integrations.dialog.desktop.breakage
integrations.dialog.desktop.undo
integrations.dialog.desktop.restart
integrations.dialog.desktop.confirm
integrations.detail.desktopDesiredOff
integrations.detail.desktopDesiredOnNotApplied
integrations.native.error.desktopUnsafeMetadata
integrations.native.error.desktopCleanupIncomplete
integrations.native.msg.desktopDisabled
integrations.native.msg.desktopEnabled
claudeDesktop.status.disabled
claudeDesktop.enableApply
```

`changes` interpolates `{path}`; `desktopUnsafeMetadata` interpolates `{path}`;
`desktopCleanupIncomplete` interpolates `{paths}`. Do not put a credential value
or profile JSON into any interpolation.

## Test plan

`tests/desktop-3p-removal.test.ts` uses
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`/explicit options and `mkdtempSync`; it never
resolves the user's live library.

1. Normal disable writes a fresh UUID `{}` profile, verifies it is readable,
   points `appliedId` to it, removes only the old opencodex row, and preserves
   unrelated rows/top-level fields.
2. **Dangling Default fixture:** `_meta.json` contains `Default`, but its
   `<id>.json` does not exist. Disable neither selects nor changes that row; the
   selected fresh standard file exists. This reproduces the real-machine fact.
3. The replacement JSON has no `inferenceProvider`,
   `inferenceGatewayApiKey`, or other credential field. Do not assert by printing
   values; assert key absence.
4. The old `<id>.json.bak` exists before removal and is absent after. This is a
   mandatory security assertion, not incidental cleanup. The old `<id>.json` is
   also absent.
5. Crash fixtures resume from every table row above: selected standard + both old
   files; backup gone; both files gone + old row present; markers handled at the
   route layer. Every retry ends with one selected opencodex row and no old files.
6. Metadata malformed, path-escaping id, and two non-selected opencodex cleanup
   rows each REFUSE `unsafe_metadata` without a Desktop-library write.
7. Injected delete failure returns `cleanup_incomplete`, keeps the old row as
   locator, reports residual paths only, and leaves selected standard readable.
8. Idempotent retry allocates no second standard profile.
9. Re-enable prefers the selected standard row, overwrites it through the normal
   gateway writer, and does not revive an old interrupted-cleanup id.

`tests/native-claude-desktop-toggle.test.ts` follows the injected-persist seam in
`tests/native-claude-code-toggle.test.ts:18-43`:

1. Absent WP3 key reads desired ON; upgrade behavior is unchanged.
2. Disable persists desired false and `desktopAutoApply:false` before the remover
   seam is called; a spy records call order.
3. Successful cleanup clears only `appliedFingerprint`/`appliedAt` and preserves
   all assignments/defaults (include 33 assignments to pin the observed scale).
4. `unsafe_metadata` leaves desired OFF persisted and markers intact, returning
   409 with the typed refusal.
5. Cleanup partial returns 500, residual paths, selected-standard state, desired
   OFF, and no false success.
6. Config `SQLITE_BUSY` refuses before any Desktop mutation; broken lock is 500.
7. Two concurrent PUTs produce one `config_busy` and no overlapping remover.
8. Auto-apply that is paused in `fetchAllModels`, then disabled, hits the second
   guard and never calls `writeDesktop3pConfig`. This activates the race fix at
   `agent-settings-routes.ts:137-139`, not merely its first guard.
9. Enable and explicit POST apply persist desired true, keep assignments/defaults,
   regenerate the gateway profile, and record markers only after write success.

MODIFY `tests/claude-messages-endpoint.test.ts`: start from Claude Code enabled,
perform the Desktop disable PUT against a temp config library, then send a valid
Claude Code `/v1/messages` request through the same test server. Assert it reaches
the existing transport/adapter path rather than 403/404. Also assert the proxy
health endpoint still responds. This is the C4 proof that Desktop OFF does not
shut down the shared transport.

GUI cases:

- `integrations-overview-rows.test.ts`: switch uses desired state while badge and
  applied count use observed state; OFF + stale marker is not green.
- `integrations-surfaces.test.tsx`: Desktop card has a keyboard-operable switch;
  disable opens the Desktop—not Grok—dialog; all five paragraphs render in order;
  confirm calls `/api/native-integrations/claude-desktop`; restart-required text
  is visible before confirm; focus returns to the switch.
- `claude-desktop-locale.test.ts`: all 14 keys exist and are non-empty in all six
  locales.

## Verification

Implementation C-gate commands:

```bash
bun run typecheck
bun test --isolate tests/desktop-3p-removal.test.ts tests/native-claude-desktop-toggle.test.ts tests/claude-messages-endpoint.test.ts tests/claude-management-api.test.ts
bun run test
bun run privacy:scan
cd gui && bun test tests
cd gui && bun run lint
cd gui && bun run lint:i18n
cd gui && bun run build
```

Render grounding: open the Integrations overview in the real dashboard, activate
the Desktop OFF switch with keyboard, screenshot the open dialog at desktop and
constrained width, read the screenshot back, and verify the restart sentence is
visible before confirmation. In browser QA, point the server at a temporary
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`; do not confirm against the live daemon.

Real-machine proof is deliberately read-only. It may parse only
`configLibrary/_meta.json` to report row names/ids and `existsSync(<id>.json)`
booleans, confirming the known dangling `Default` shape and that path resolution
targets the installed Desktop library. It must not open or print any profile or
`.bak` contents. All destructive activation proof runs against `mkdtempSync` on
the same machine. Do **not** call the live PUT endpoint, remover, `unlink`, or
apply route against the user's real Desktop library; that would change the active
selection and delete credential-bearing files without separate approval.

## Accept criteria

- **C7** (`000_plan.md:91-92`) — after a successful disable, `_meta.json.appliedId`
  names a present, readable `{}` profile with no `inferenceProvider` or credential
  fields; the previous opencodex `<id>.json` and `<id>.json.bak` are absent. The
  dangling-Default fixture proves no `Default` assumption entered the path.
- **C4** (`000_plan.md:86-87`) — disable does not stop/restart the proxy and does
  not change `claudeCode.enabled`; a Claude Code request still traverses
  `/v1/messages` after Desktop is disabled, and proxy health remains live.
- Desired OFF and `desktopAutoApply:false` are durable before the Desktop write;
  a failed/partial mutation reports desired OFF versus observed residue rather
  than silently re-enabling.
- Assignments/defaults survive disable and enable byte-semantically as parsed
  data; only `appliedFingerprint`/`appliedAt` are cleared after complete cleanup.
- The dialog states before confirmation that a full Desktop quit/reopen is
  required. No UI or API claims the running Desktop process changed instantly.
