# WP5 — the Codex CLI toggle, with artifact-level restore truth

Research: `001_native_restore_thesis.md`. Read it first; this doc is the diff.

The failure this phase closes is concrete: `restoreNativeCodex()` can leave routed
threads hidden when the history database is locked, yet return `success: true`
because that boolean is copied from config restore alone
(`src/codex/inject.ts:783-794`). Disable and enable already exist as
`restoreNativeCodex()` and `syncModelsToCodex(port)` while the proxy keeps serving
(`src/cli/index.ts:745-768`); WP3 already adds the durable, default-ON
`clientIntegrations.codex` intent (`003_durable_desired_state.md:87-115`). This
phase adds the missing artifact-level result, classifies the held-history failure,
registers Codex in the existing native-integration route family, and gives the
overview card an honest switch. It adds no operation journal or lifecycle engine.

## IN / OUT

IN:

- `src/codex/history-provider.ts` (MODIFY) — retain the exhausted retry's
  classified reason instead of reducing it to `null`.
- `src/codex/inject.ts` (MODIFY) — return config/catalog/history results and make
  aggregate success mean all required artifacts succeeded.
- `src/server/management/context.ts` (MODIFY) — add Codex mutation seams so route
  tests cannot touch the developer's real Codex home.
- `src/server/management/native-integration-routes.ts` (MODIFY) — add Codex to
  GET and `PUT /api/native-integrations/codex`, persisting WP3 intent before the
  client mutation.
- `gui/src/pages/integrations/overview-clients.ts` (MODIFY),
  `gui/src/pages/integrations/IntegrationsOverview.tsx` (MODIFY),
  `gui/src/pages/integrations/native-api.ts` (MODIFY), and
  `gui/src/pages/integrations/refusal-copy.ts` (MODIFY) — wire the card, dialog,
  structured native API vocabulary, and localized refusal copy.
- `gui/src/i18n/en.ts`, `de.ts`, `ja.ts`, `ko.ts`, `ru.ts`, `zh.ts` (MODIFY) —
  source copy plus all five translations required by `gui/AGENTS.md:13-19`.
- `tests/native-codex-toggle.test.ts` (NEW),
  `tests/codex-history-provider.test.ts` (MODIFY),
  `tests/codex-journal.test.ts` (MODIFY),
  `gui/tests/integrations-overview-rows.test.ts` (MODIFY),
  `gui/tests/overview-state-merge.test.ts` (MODIFY), and
  `gui/tests/consequence-dialog.test.tsx` (MODIFY).

OUT:

- `src/codex/sync.ts` — enable delegates to the existing full catalog refresh +
  injection path at lines 83-110; changing it is not needed.
- `src/cli/index.ts`, `src/server/management-api.ts`, and `src/service.ts` — their
  existing `restoreNativeCodex().success` checks become more truthful through the
  widened return type; no lifecycle caller needs a new state machine.
- `/v1/responses` and every data-plane router — a client flag gates automatic
  Codex config writes, never the shared transport (`003_durable_desired_state.md:117-130`).
- `src/integrations/writer.ts`, operation records, snapshots, undo routes, and the
  superseded `src/integrations/native/codex.ts` idea — turning the switch back on
  is `syncModelsToCodex`, not replay.
- `gui/dist`, docs publishing, releases, deployment, and any live proxy mutation.

## The structured result

MODIFY `src/codex/history-provider.ts` at the current
`CodexHistorySyncResult` (`:162-168`):

```ts
export type CodexHistoryFailureReason = "busy" | "permission";

export interface CodexHistorySyncResult {
  rows: number;
  files: number;
  ejectedRows?: number;
  /** The mutation was skipped after every retry; zero rows is not a successful no-op. */
  failed?: true;
  /**
   * Why the retry budget was exhausted. `failed` alone caused the Codex-toggle
   * incident: SQLITE_BUSY and EACCES both became the same boolean, then
   * restoreNativeCodex converted that boolean to prose while keeping
   * `success: true`. Callers need this discriminator to recommend a retry only
   * for contention and to stop treating an ACL failure as a lock that will pass.
   */
  failureReason?: CodexHistoryFailureReason;
}
```

MODIFY `src/codex/inject.ts` above `restoreNativeCodex()` (currently line 764):

```ts
export type CodexRestoreArtifactState = "ok" | "skipped" | "failed";

export interface CodexRestoreConfigResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  action: "journal-restored" | "owned-fields-stripped" | "external-provider-preserved" | "failed";
  message: string;
}

export interface CodexRestoreCatalogResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  removed: number;
  kept: number;
  path: string | null;
  message: string;
}

export interface CodexRestoreHistoryResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  reason?: CodexHistoryFailureReason;
  rows: number;
  files: number;
  ejectedRows: number;
  message: string;
}

export interface CodexNativeRestoreResult {
  /**
   * True only when every artifact required for a native Codex view succeeded.
   * The former boolean described config only, so the held-history incident
   * returned true while routed threads remained tagged opencodex and invisible.
   * Consumers must inspect `artifacts` for the failed boundary; they must never
   * recover structure by parsing `message`.
   */
  success: boolean;
  message: string;
  externalProvider?: string;
  artifacts: {
    config: CodexRestoreConfigResult;
    catalog: CodexRestoreCatalogResult;
    history: CodexRestoreHistoryResult;
  };
}
```

`restoreNativeCodex(): CodexNativeRestoreResult` keeps the existing operation
order but catches and records each artifact boundary separately. Config uses
`restoreJournalState()` and then the existing `removeCodexConfig()` fallback
(`src/codex/inject.ts:770-774`); catalog delegates once to
`restoreCodexCatalog()` (`src/codex/catalog/sync.ts:572-597`); history delegates
once to `syncCodexHistoryProvider("openai", ...)` (`src/codex/inject.ts:775-783`).
Aggregate `success` is `config.state !== "failed" && catalog.state !== "failed"
&& history.state !== "failed"`. Existing callers can keep reading `.success` and
`.message`, but a history failure now makes `.success === false`.

The external-provider courtesy is a successful skip, not a fake restore. When
`currentExternalCodexModelProvider()` returns (currently lines 765-768), remove
only the stale journal and return all three artifacts as `state: "skipped"`,
config action `external-provider-preserved`, and `externalProvider`. No catalog
or history function runs. That preserves the existing behavior for `custom`
while giving the card a stable fact to show.

## The route

Method and path: `PUT /api/native-integrations/codex` with
`Content-Type: application/json`.

Request:

```ts
{ enabled: boolean }
```

Success (`200`), using the existing envelope and adding optional Codex detail:

```ts
{
  ok: true;
  clientId: "codex";
  changed: boolean;
  state: "absent" | "current" | "unsafe";
  message: string;
  reason?: "external_provider_preserved" | "catalog_warning";
  artifacts?: CodexNativeRestoreResult["artifacts"];
}
```

Disable persists `clientIntegrations.codex = false` first, then checks teardown
ownership and calls `restoreNativeCodex()`. That order is intentional: WP3 says
desired OFF survives an ownership refusal or drift so a later automatic apply
cannot reverse the user's request (`003_durable_desired_state.md:112-115`). Use a
cloned config for persistence, then update the request's in-memory config only
after persistence succeeds; a failed config lock must not create an in-memory-only
OFF. Enable likewise persists `true`, resolves the running listener from
`readRuntimePort(process.pid)` with request/config fallback, and calls
`syncModelsToCodex(port, config, null)`. Bare `injectCodexConfig()` is forbidden:
it does not rebuild routed catalog rows (`src/codex/sync.ts:83-110`).

GET `/api/native-integrations` adds a Codex row. Its `state` is observed routing
from `getCodexRoutingKind()` (`src/codex/inject.ts:255-273`), not merely desired
intent: `opencodex-local` is `current`, `native` is `absent`, and
`custom-local|custom-remote|unknown` is `unsafe` unless an external
`model_provider` explains it, in which case it is `absent` with
`reason: "external_provider_preserved"` and a message naming that provider.
`disableBlocked` carries `home_mismatch` only while teardown would touch our
artifacts. Consume WP3's `clientIntegrationEnabled()` and
`setClientIntegrationEnabled()` owners (`020_desired_state.md:149-183`); no WP5
caller open-codes the map's defaulting rule.

Every refusal uses the existing
`refusal(status, clientId, reason, message)` function unchanged
(`src/server/management/native-integration-routes.ts:76-87`):

| HTTP | reason | Trigger | Observable state |
|---|---|---|---|
| 409 | `config_busy` | WP3 desired-state persistence loses a real `SQLITE_BUSY` lock race | No durable intent or Codex artifact changed; retry is correct |
| 409 | `home_mismatch` | disable sees an installed service owned by another Codex/OpenCodex home | Desired OFF is durable; Codex artifacts are untouched |
| 409 | `history_busy` | config and catalog restored, history retries exhaust on busy/locked contention | Desired OFF is durable; native routing is active, but routed threads remain hidden until retry |
| 500 | `history_permission` | config and catalog restored, history fails with `EPERM`/`EACCES` | Desired OFF is durable; user must fix permissions, not wait |
| 500 | `write_failed` | desired-state persistence cannot open its lock, config/catalog restore fails, or enable sync returns `ok: false` | Message names the failed boundary; no retry promise unless the cause is known |

Malformed JSON and non-boolean `enabled` retain the route family's existing
plain `400` responses (`native-integration-routes.ts:206-215,381-391`); these are
request errors, not native refusals. An external provider is not a refusal: the
desired flag changes and the response is `200`, reason
`external_provider_preserved`, while the config/catalog/history stay untouched.

Refusal/failure response (the existing envelope, unchanged):

```ts
{
  error: "native integration change refused" | "native integration change failed";
  code: "native_integration_refused" | "native_integration_failed";
  clientId: "codex";
  reason: "config_busy" | "home_mismatch" | "history_busy"
    | "history_permission" | "write_failed";
  message: string;
}
```

Invalid bodies remain `{ error: "invalid JSON body" }` or
`{ error: "enabled must be a boolean" }` with HTTP 400.

MODIFY `src/server/management/native-integration-routes.ts`:

```diff
+import {
+  currentExternalCodexModelProvider,
+  getCodexConfigPath,
+  getCodexRoutingKind,
+  restoreNativeCodex,
+  type CodexNativeRestoreResult,
+} from "../../codex/inject";
+import { syncModelsToCodex } from "../../codex/sync";
-import { readRuntimePort, saveConfigPreservingClaudeCode } from "../../config";
+import {
+  clientIntegrationEnabled, readRuntimePort, saveConfigPreservingClaudeCode,
+  setClientIntegrationEnabled,
+} from "../../config";
@@
-export type NativeIntegrationClientId = "claude" | "grok";
+export type NativeIntegrationClientId = "codex" | "claude" | "grok";
@@
   | "config_busy"
+  | "history_busy"
+  | "history_permission"
   | "write_failed";
@@
 export interface NativeStatus {
@@
   disableBlocked: { reason: NativeRefusalReason; message: string } | null;
+  reason?: "external_provider_preserved";
+  externalProvider?: string;
 }
@@
-  reason?: string;
+  reason?: "non_loopback_removed" | "non_loopback_superseded"
+    | "external_provider_preserved" | "catalog_warning";
+  externalProvider?: string;
+  artifacts?: CodexNativeRestoreResult["artifacts"];
@@
+function codexStatus(ctx: ManagementContext): NativeStatus {
+  const { deps } = ctx;
+  const externalProvider = (deps.currentExternalCodexModelProvider
+    ?? currentExternalCodexModelProvider)();
+  const routing = (deps.getCodexRoutingKind ?? getCodexRoutingKind)();
+  const owned = routing === "opencodex-local" ? assertNativeTeardownOwned() : null;
+  return {
+    clientId: "codex",
+    state: externalProvider ? "absent"
+      : routing === "opencodex-local" ? "current"
+      : routing === "native" ? "absent" : "unsafe",
+    installed: true,
+    configPath: getCodexConfigPath(),
+    disableBlocked: owned && !owned.ok
+      ? { reason: "home_mismatch", message: owned.message } : null,
+    ...(externalProvider ? {
+      reason: "external_provider_preserved" as const, externalProvider,
+    } : {}),
+  };
+}
@@
-      clients: [claudeStatus(config, getConfigPath()), grokStatus()],
+      clients: [codexStatus(ctx), claudeStatus(config, getConfigPath()), grokStatus()],
@@
+  if (url.pathname === "/api/native-integrations/codex" && req.method === "PUT") {
+    let body: { enabled?: unknown };
+    try {
+      body = await readManagementJsonBody(req);
+    } catch (error) {
+      rethrowManagementBodyTooLarge(error);
+      return jsonResponse({ error: "invalid JSON body" }, 400);
+    }
+    if (typeof body.enabled !== "boolean") {
+      return jsonResponse({ error: "enabled must be a boolean" }, 400);
+    }
+    const enabled = body.enabled;
+
+    const desiredChanged = clientIntegrationEnabled(config, "codex") !== enabled;
+    if (desiredChanged) {
+      const next = { ...config, clientIntegrations: { ...config.clientIntegrations } };
+      setClientIntegrationEnabled(next, "codex", enabled);
+      const persist = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
+      try {
+        persist(next);
+      } catch (error) {
+        if (!isConfigLockError(error)) throw error;
+        return isLockContention(error)
+          ? refusal(409, "codex", "config_busy",
+              "Another process is saving the configuration right now. Try again in a moment.")
+          : refusal(500, "codex", "write_failed",
+              `The configuration lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`);
+      }
+      // Change the request-scoped object only after durable persistence succeeds.
+      setClientIntegrationEnabled(config, "codex", enabled);
+    }
+
+    if (!enabled) {
+      const owned = assertNativeTeardownOwned();
+      if (!owned.ok) return refusal(409, "codex", "home_mismatch", owned.message);
+      const restore = (deps.restoreNativeCodex ?? restoreNativeCodex)();
+      if (!restore.success) {
+        const history = restore.artifacts.history;
+        const otherArtifactsOk = restore.artifacts.config.state !== "failed"
+          && restore.artifacts.catalog.state !== "failed";
+        if (otherArtifactsOk && history.state === "failed" && history.reason === "busy") {
+          return refusal(409, "codex", "history_busy", history.message);
+        }
+        if (otherArtifactsOk && history.state === "failed" && history.reason === "permission") {
+          return refusal(500, "codex", "history_permission", history.message);
+        }
+        return refusal(500, "codex", "write_failed", restore.message);
+      }
+      return jsonResponse({
+        ok: true, clientId: "codex",
+        changed: desiredChanged || Object.values(restore.artifacts).some(a => a.changed),
+        state: "absent",
+        message: restore.message, artifacts: restore.artifacts,
+        ...(restore.externalProvider ? {
+          reason: "external_provider_preserved" as const,
+          externalProvider: restore.externalProvider,
+        } : {}),
+      } satisfies NativeToggleEnvelope);
+    }
+
+    const externalProvider = (deps.currentExternalCodexModelProvider
+      ?? currentExternalCodexModelProvider)();
+    const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
+    const port = runtime?.port ?? (Number(url.port) || config.port);
+    const synced = await (deps.syncModelsToCodex ?? syncModelsToCodex)(port, config, null);
+    if (!synced.ok) return refusal(500, "codex", "write_failed", synced.message);
+    return jsonResponse({
+      ok: true, clientId: "codex", changed: desiredChanged || !externalProvider,
+      state: externalProvider ? "absent" : "current", message: synced.message,
+      ...(externalProvider ? {
+        reason: "external_provider_preserved" as const, externalProvider,
+      } : synced.warning ? { reason: "catalog_warning" as const } : {}),
+    } satisfies NativeToggleEnvelope);
+  }
```

MODIFY `src/server/management/context.ts` with typed optional seams for
`restoreNativeCodex`, `syncModelsToCodex`, `getCodexRoutingKind`, and
`currentExternalCodexModelProvider`. The production defaults are the real
functions; `tests/native-codex-toggle.test.ts` supplies deterministic results.
This follows the existing reason for `saveConfigPreservingClaudeCode` and Grok's
writer/catalog seams (`context.ts:12-37`).

## History-lock classification

The current low-level code cannot distinguish the two outcomes after retry. It
recognizes `SQLITE_BUSY`, `SQLITE_LOCKED`, `EBUSY`, `EPERM`, and `EACCES` in one
predicate (`src/codex/history-provider.ts:511-523`), then `withHistoryRetry()`
discards the final error and returns `null` (`:536-548`). The caller therefore has
no code left to inspect at line 577. Saying the GUI can classify this today would
be false.

The minimal change is one classifier and one internal discriminated retry helper:

```ts
export function classifyRecoverableHistoryError(
  error: unknown,
): CodexHistoryFailureReason | null {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (["SQLITE_BUSY", "SQLITE_LOCKED", "EBUSY"].includes(code)
    || message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("resource busy")) return "busy";
  if (["EPERM", "EACCES"].includes(code)
    || message.includes("operation not permitted")
    || message.includes("permission denied")) return "permission";
  return null;
}
```

`isRecoverableHistoryError(error)` becomes
`classifyRecoverableHistoryError(error) !== null`, preserving its public boolean
contract and existing tests. New internal `withHistoryRetryResult()` returns
`{ ok: true, value } | { ok: false, reason }`; exported `withHistoryRetry()` wraps
it and still returns `T | null`, preserving callers/tests at
`tests/codex-history-provider.test.ts:309-361`. `syncCodexHistoryProvider()` uses
the detailed helper and emits `{ rows: 0, files: 0, failed: true,
failureReason: retry.reason }`. Neither `restoreNativeCodex`, the route, nor the
GUI parses error prose.

## GUI

`codexRow` currently hard-codes `toggle: null` and ignores the native family
(`gui/src/pages/integrations/overview-clients.ts:118-150`). Make its status merge
match Claude/Grok: find `nativeCodex`, wait for `nativeSettled`, set
`toggle: "codex"`, `toggleBlocked`, and `togglePath` from that row, and keep the
badge based on observed `native.state`. When `native.reason` is
`external_provider_preserved`, use the localized detail key with the structured
provider name so the card says another provider owns routing instead of saying
opencodex is applied.

MODIFY `gui/src/pages/integrations/overview-clients.ts`:

```diff
-function codexRow(payload: CodexRoutingPayload | null): OverviewRow {
+function codexRow(
+  payload: CodexRoutingPayload | null,
+  native: NativeStatus | undefined,
+  nativeSettled: boolean,
+): OverviewRow {
   const base = {
@@
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
+    toggle: "codex" as const,
+    toggleBlocked: native?.disableBlocked ?? null,
+    togglePath: native?.configPath ?? null,
@@
+  if (!nativeSettled) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
+  if (!native) return { ...base, toggle: null, state: "unknown", installed: false, applied: false, detailKey: null };
+  if (native.reason === "external_provider_preserved") {
+    return { ...base, state: native.state, installed: true, applied: false,
+      detail: null, detailKey: "integrations.native.msg.codexExternalProvider",
+      detailVars: { provider: native.externalProvider ?? "" } };
+  }
@@
 export function buildOverviewRows(sources: OverviewSources): OverviewRow[] {
+  const nativeCodex = sources.native?.find(status => status.clientId === "codex");
@@
-    codexRow(sources.codex),
+    codexRow(sources.codex, nativeCodex, sources.nativeSettled),
```

`IntegrationsOverview.tsx` adds `CODEX_DISABLE_COPY`, admits `codex` anywhere the
native toggle union is narrowed, refreshes `codexResource` after the mutation,
and chooses copy by `pendingToggle.id` instead of always rendering Grok's copy.

```diff
+const CODEX_DISABLE_COPY: ConsequenceCopy = {
+  titleKey: "integrations.dialog.codex.title",
+  changesKey: "integrations.dialog.codex.changes",
+  breakageKey: "integrations.dialog.codex.breakage",
+  undoKey: "integrations.dialog.codex.undo",
+  sideEffectKey: "integrations.dialog.codex.sideEffect",
+  confirmKey: "integrations.dialog.codex.confirm",
+};
@@
-      } else if (row.toggle === "claude" || row.toggle === "grok") {
+      } else if (row.toggle === "codex" || row.toggle === "claude" || row.toggle === "grok") {
@@
-    if (row.status || next || row.id === "claude" || row.toggle === null) {
+    if (row.status || next || row.id === "claude" || row.toggle === null) {
       void toggleCard(row, next);
       return;
     }
-    // Grok disable is the only native action that edits another program's file.
+    // Codex and Grok disable both alter another client's on-disk state and earn
+    // the consequence gate; Claude changes only our own flag and stays immediate.
@@
-          copy={{ ...GROK_DISABLE_COPY, vars: { path: pendingToggle.togglePath ?? "" } }}
+          copy={{
+            ...(pendingToggle.id === "codex" ? CODEX_DISABLE_COPY : GROK_DISABLE_COPY),
+            vars: { path: pendingToggle.togglePath ?? "" },
+          }}
```

The same `IntegrationsOverview.tsx` diff handles the Codex-only success caveat and
refreshes both observed sources:

```diff
+        } else if (result.reason === "external_provider_preserved") {
+          setCardResult(row.id, { tone: "ok", text: t(
+            "integrations.native.msg.codexExternalProvider",
+            { provider: result.externalProvider ?? "" },
+          ) });
+        }
@@
   const refreshNativeDetails = () => {
     nativeResource.refresh();
+    codexResource.refresh();
     claudeResource.refresh();
```

MODIFY `gui/src/pages/integrations/native-api.ts`; both runtime allowlists must
widen with the TypeScript unions, or a valid server refusal will be downgraded to
an opaque `NativeApiError` (`native-api.ts:51-75`):

```diff
-export type NativeIntegrationClientId = "claude" | "grok";
+export type NativeIntegrationClientId = "codex" | "claude" | "grok";
@@
   | "config_busy"
+  | "history_busy"
+  | "history_permission"
   | "write_failed";
@@
 export interface NativeStatus {
@@
   disableBlocked: { reason: NativeRefusalReason; message: string } | null;
+  reason?: "external_provider_preserved";
+  externalProvider?: string;
@@
 export interface NativeToggleEnvelope {
@@
   reason?: string;
+  externalProvider?: string;
+  artifacts?: CodexNativeRestoreArtifacts;
@@
-const NATIVE_CLIENTS = new Set<NativeIntegrationClientId>(["claude", "grok"]);
+const NATIVE_CLIENTS = new Set<NativeIntegrationClientId>(["codex", "claude", "grok"]);
@@
   "config_busy",
+  "history_busy",
+  "history_permission",
   "write_failed",
```

Define the GUI's structural `CodexNativeRestoreArtifacts` beside the envelope;
do not import a runtime type across the `src/`/`gui/` package boundary. The shape
matches the three server artifacts exactly and keeps `reason` typed as
`"busy" | "permission"` on history.

```ts
export interface CodexNativeRestoreArtifacts {
  config: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    action: "journal-restored" | "owned-fields-stripped"
      | "external-provider-preserved" | "failed";
    message: string;
  };
  catalog: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    removed: number;
    kept: number;
    path: string | null;
    message: string;
  };
  history: {
    state: "ok" | "skipped" | "failed";
    changed: boolean;
    reason?: "busy" | "permission";
    rows: number;
    files: number;
    ejectedRows: number;
    message: string;
  };
}
```

MODIFY `gui/src/pages/integrations/refusal-copy.ts` at the existing native reason
switch (`:56-71`):

```diff
   if (refusal.reason === "not_installed") return t("integrations.native.error.notInstalled");
   if (refusal.reason === "config_busy") return t("integrations.native.error.configBusy");
+  if (refusal.reason === "history_busy") return t("integrations.native.error.historyBusy");
+  if (refusal.reason === "history_permission") return t("integrations.native.error.historyPermission");
   return refusal.message || t("integrations.error.generic");
```

The English source text is exact:

- `integrations.dialog.codex.title` — `Disable the Codex integration?`
- `integrations.dialog.codex.changes` — `opencodex will remove its routing from {path}, remove its generated profile, restore the native model catalog, and retag resumable threads for native Codex.`
- `integrations.dialog.codex.breakage` — `Plain codex will connect directly to OpenAI, and models routed from other providers will disappear from Codex. The proxy and /v1/responses stay running for other clients.`
- `integrations.dialog.codex.undo` — `Turning this back on rebuilds the routed catalog from the models available then and injects Codex again. Resume history is made usable in the matching direction, but its files are not restored byte for byte.`
- `integrations.dialog.codex.sideEffect` — `If you selected a routed root model after opencodex injected the config, disabling removes that model selection and turning the integration back on cannot reconstruct it; select the model again. If an external model_provider owns Codex, opencodex removes only its stale journal and leaves the config, catalog, and history unchanged.`
- `integrations.dialog.codex.confirm` — `Disable`

The model-selection sentence is deliberately stronger than the superseded copy.
The fallback strip removes any root slash-qualified `model = "provider/slug"`
after post-injection drift (`src/codex/inject.ts:315-327,688-705`), and no restore
record exists from which enable could rebuild it. Resume history is reversible in
provider meaning but appends/patches metadata rather than restoring bytes
(`src/codex/history-provider.ts:52-90,480-508`).

Refusal/success copy in `gui/src/pages/integrations/refusal-copy.ts` and the native
result branch:

- `history_busy` — `Codex routing is disabled, but routed threads are still hidden because Codex or an IDE is holding the history database. Close Codex and the IDE, then turn the integration off again.`
- `history_permission` — `Codex routing is disabled, but opencodex does not have permission to retag the history database. Fix the Codex history file permissions, then turn the integration off again.`
- `external_provider_preserved` — `Codex is using the external model provider {provider}. opencodex left its config, catalog, and history unchanged.`

`history_busy` and `history_permission` replace server prose by reason, just as
`orphaned_marker` and `config_busy` do today
(`gui/src/pages/integrations/refusal-copy.ts:56-71`). `write_failed` continues to
show the server's boundary-specific message. A refusal is rendered in the card's
notice area after the dialog closes; it never opens a second modal, matching the
established direction (`../260803_integrations_toggle_all/002_consequence_dialog_ux.md:124-149`).

## i18n

Add these exact keys to all six locale files:

```text
integrations.dialog.codex.title
integrations.dialog.codex.changes
integrations.dialog.codex.breakage
integrations.dialog.codex.undo
integrations.dialog.codex.sideEffect
integrations.dialog.codex.confirm
integrations.native.error.historyBusy
integrations.native.error.historyPermission
integrations.native.msg.codexExternalProvider
```

`gui/src/i18n/en.ts` is the English source and `TKey` authority. Add matching
translations to `de.ts`, `ja.ts`, `ko.ts`, `ru.ts`, and `zh.ts`; do not hardcode
the dialog or refusal text in JSX (`gui/AGENTS.md:13-30`). `{path}` appears in
`changes`; `{provider}` appears in `codexExternalProvider`.

## Test plan

`tests/codex-history-provider.test.ts`:

1. `SQLITE_BUSY`, `SQLITE_LOCKED`, `EBUSY`, and the existing lock/busy message
   fallbacks classify as `busy`.
2. `EPERM`, `EACCES`, `operation not permitted`, and `permission denied` classify
   as `permission`.
3. Corruption/programming errors classify `null` and still throw.
4. Exhausted detailed retry preserves the last reason; exported
   `withHistoryRetry()` still returns `null` for compatibility.
5. `syncCodexHistoryProvider()` against a held real `BEGIN IMMEDIATE` transaction
   returns `failed: true, failureReason: "busy"`; an ACL/code fixture returns
   `permission`. The real lock case is the activation proof, not only a mocked object.

`tests/codex-journal.test.ts`:

1. A complete restore reports all three artifact objects and `success: true`.
2. A config failure, catalog failure, and history failure each name only that
   boundary and make aggregate success false.
3. External `model_provider = "custom"` removes only the journal, invokes neither
   catalog nor history mutation, and returns three structured skips.
4. A drifted post-injection root `model = "provider/slug"` is removed; reinjection
   does not recreate it. This pins the dialog's destructive sentence.

`tests/native-codex-toggle.test.ts`:

1. GET includes `clientId: "codex"` and reports observed native/current/unsafe
   routing without reading desired intent as disk truth.
2. Missing WP3 flag defaults ON; explicit false survives a fresh config load.
3. Disable persists false, passes ownership, calls structured restore once, and
   never calls a stop/drain function.
4. Enable persists true and calls `syncModelsToCodex` with the running listener's
   port; a test fails if the route calls bare injection.
5. Held history returns HTTP 409, reason `history_busy`, code
   `native_integration_refused`; config/catalog are already native and desired OFF
   remains persisted. The response is never 200/green and never raw 500.
6. Permission failure returns HTTP 500, reason `history_permission`, code
   `native_integration_failed`, with no retry advice.
7. Home mismatch returns 409 after desired OFF is persisted and before any Codex
   artifact mutation.
8. External `custom` returns 200 `external_provider_preserved`; all three artifact
   states are skipped and the status row carries the courtesy message.
9. Invalid JSON/non-boolean bodies return 400; config-lock contention is 409 while
   an unopenable lock is 500, matching `tests/native-claude-code-toggle.test.ts:120-154`.
10. Start a real test proxy with another routed client, disable Codex through the
    management route, then POST that client's deliberately local fixture request
    to `/v1/responses` and assert its expected response. Also assert `/healthz`
    identifies the same PID before and after. This proves the shared endpoint and
    process stayed alive; checking only the PUT response would not prove C4.

GUI tests:

1. `gui/tests/integrations-overview-rows.test.ts` — settled native Codex gains a
   toggle/path/blocker; missing or unsettled native evidence remains unknown with
   no active switch; external provider renders the courtesy detail and no applied
   claim.
2. `gui/tests/overview-state-merge.test.ts` — widen client/reason validators and
   prove localized `history_busy` and `history_permission`; keep raw
   `write_failed` detail.
3. `gui/tests/consequence-dialog.test.tsx` — render the Codex copy in slot order,
   assert the root-model loss, non-byte-identical history, external-provider
   courtesy, and `/v1/responses` survival sentences, plus focus return and the
   pending double-submit guard already tested for Grok.

## Verification

Static and automated gates:

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts tests/codex-journal.test.ts tests/native-codex-toggle.test.ts
bun run test
cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build
cd .. && bun run privacy:scan
```

Live HTTP proof uses the already-running proxy at `localhost:10100`; do not call
`ocx stop` or `ocx restore`. Run only in the implementation C phase, after taking
a copy of the user's current Codex config for inspection and with an admin token
supplied by the maintainer:

```bash
export OCX_LIVE_BASE=http://localhost:10100
export OCX_ADMIN_TOKEN="${OPENCODEX_ADMIN_AUTH_TOKEN:?set the live management token without printing it}"

curl -fsS "$OCX_LIVE_BASE/healthz" > .tmp/wp5-health-before.json
curl -fsS -H "x-opencodex-api-key: $OCX_ADMIN_TOKEN" \
  "$OCX_LIVE_BASE/api/native-integrations" > .tmp/wp5-native-before.json

curl -fsS -X PUT -H "x-opencodex-api-key: $OCX_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"enabled":false}' \
  "$OCX_LIVE_BASE/api/native-integrations/codex" > .tmp/wp5-disable.json
curl -fsS "$OCX_LIVE_BASE/healthz" > .tmp/wp5-health-disabled.json
curl -sS -o .tmp/wp5-other-client.json -w '%{http_code}\n' \
  -H "x-opencodex-api-key: $OCX_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{}' "$OCX_LIVE_BASE/v1/responses"

curl -fsS -X PUT -H "x-opencodex-api-key: $OCX_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"enabled":true}' \
  "$OCX_LIVE_BASE/api/native-integrations/codex" > .tmp/wp5-enable.json
curl -fsS -H "x-opencodex-api-key: $OCX_ADMIN_TOKEN" \
  "$OCX_LIVE_BASE/api/native-integrations" > .tmp/wp5-native-after.json
curl -fsS "$OCX_LIVE_BASE/healthz" > .tmp/wp5-health-after.json
```

Read every JSON artifact. Disable must show Codex `absent` (or the classified
history refusal), enable must show `current` unless the explicit external-provider
courtesy applies, and all three health files must identify the same running proxy.
The `/v1/responses` invalid-body probe must reach the data-plane handler (an
expected validation/auth response, not connection refusal or 404); the automated
fixture test above is the stronger proof that another client completes a routed
request without spending live provider credits. Finally inspect the emitted Codex
catalog after enable and prove at least one current `provider/model` row exists;
an injected config beside a native-only catalog does not satisfy C5.

For the held-history activation, open Codex so its writer lock is genuinely held,
disable once, and require HTTP 409 `history_busy` plus the localized card notice.
Close Codex/IDE, disable again, and require success with history `state: "ok"`.
Do not simulate this live proof by editing the response or matching its message.

## Accept criteria

- **C5 — Codex toggles both directions from the overview with the proxy running.**
  Disable calls structured `restoreNativeCodex`; enable calls
  `syncModelsToCodex(runtimePort)`. Live GET and on-disk catalog/config evidence
  agree after both directions, and no stop/drain path runs.
- **C6 — a held history DB is explained, never false green.** A real held lock
  yields `409 native_integration_refused / history_busy`; config and catalog are
  reported separately, desired OFF persists, the card says why routed threads
  remain hidden, and no layer parses `message`.
- **C4 — other clients keep serving.** The proxy PID/health identity is unchanged
  across disable and enable, `/v1/responses` remains registered, and another
  client's fixture request completes while Codex is OFF.
- External `model_provider` ownership remains untouched and visible on the card;
  resume history is described as semantically reversible, not byte-identical;
  and the dialog states that a post-injection routed root model selection is
  destroyed and cannot be reconstructed.
