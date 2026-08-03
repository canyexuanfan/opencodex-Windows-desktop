# WP3 — durable per-client desired state

Research: `003_durable_desired_state.md`. Read it first; this doc is the diff.

The shipped Grok switch removes its fence but records no intent. The next
`ocx start` calls `syncGrokConfig` and writes the fence back
(`src/cli/index.ts:334-341`, `src/grok/sync.ts:29-65`). WP3 gives that OFF a
durable owner before WP5 and WP6 add two more switches with the same failure
mode.

## IN / OUT

| Path | Change | Why it is in WP3 |
|---|---|---|
| `src/types.ts` | MODIFY | Defines the persisted client-id vocabulary and `OcxConfig.clientIntegrations`. |
| `src/config.ts` | MODIFY | Parses the map without turning one malformed value into an all-clients reset; owns effective-state reads and transition writes. |
| `src/codex/sync.ts` | MODIFY | Stops every Codex catalog/injection sync while Codex is desired OFF. |
| `src/server/management-api.ts` | MODIFY | Gates the direct catalog refresher that provider/model routes call, and moves Claude agent sync to the compatibility helper. |
| `src/grok/sync.ts` | MODIFY | Closes every start/ensure/restart path at the shared sync owner. |
| `src/server/management/native-integration-routes.ts` | MODIFY | Persists Grok intent before touching its file and mirrors Claude Code's old/new keys. |
| `src/server/management/agent-settings-routes.ts` | MODIFY | Requires both Desktop desired ON and `desktopAutoApply`, and mirrors Claude Code's settings route. |
| `src/cli/opencode.ts` | MODIFY | Stops the inline provider layer from bypassing an OpenCode OFF. |
| `src/cli/claude.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/claude/agents-inject.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/server/system-env.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/server/claude-messages.ts` | MODIFY | Removes the existing Claude-Code-only gate from the shared Messages transport. |
| `src/server/index.ts` | MODIFY | Removes the existing Claude-Code-only gate from shared Anthropic model discovery. |
| `tests/client-integration-desired-state.test.ts` | NEW | Pins schema defaulting, malformed-key salvage, compatibility, and mirroring. |
| `tests/client-integration-auto-gates.test.ts` | NEW | Drives every automatic gate and proves its writer is not called. |
| `tests/client-integration-transport-isolation.test.ts` | NEW | Proves one disabled client cannot shut down another client's transport. |
| `tests/native-grok-toggle.test.ts` | MODIFY | Pins persist-before-mutate and desired/observed conflict reporting. |
| `tests/native-claude-code-toggle.test.ts` | MODIFY | Pins both-key mirroring, including the old-value idempotent case. |
| `tests/claude-management-api.test.ts` | MODIFY | Pins mirroring through the older `/api/claude-code` route. |
| `tests/claude-messages-endpoint.test.ts` | MODIFY | Replaces the shipped transport-403 assertion with the shared-transport invariant. |

OUT:

| Path / surface | Reason |
|---|---|
| `gui/` | WP3 has no new switch. WP5 and WP6 consume this contract. |
| `src/integrations/writer.ts` and the six-client ownership store | Observed provenance is deleted on disable (`writer.ts:373-384`); it cannot own durable OFF intent. |
| `src/codex/journal.ts` | Crash reconciliation repairs our stale write and must run regardless of desired state. |
| `src/service.ts` stop/uninstall teardown | Teardown removes dead proxy pointers; it must neither consult nor rewrite desired state. |
| `src/grok/inject.ts` non-loopback cleanup | Credential-safety cleanup remains unconditional. |
| `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens` | They are shared transports, not client installation state. No desired-state check belongs in them. |
| Codex/Desktop mutation implementations | WP5 and WP6 own those operations. WP3 supplies only the state contract and automatic-path gates. |
| releases, publishing, deploys, tags, repository starring | No delivery or user-identity action belongs in a foundation phase. |

## The schema and its one reader

MODIFY `src/types.ts` immediately before `OcxConfig` (currently line 533), then
put the field beside `claudeCode` (currently line 544):

```diff
 export interface OcxApiKeyEntry {
   id: string;
   name: string;
   key: string;
   createdAt: string;
 }

+export type ClientIntegrationId =
+  | "codex"
+  | "claude-code"
+  | "claude-desktop"
+  | "grok"
+  | "opencode"
+  | "pi"
+  | "hermes"
+  | "openclaw"
+  | "kimi"
+  | "gajae";
+
 export interface OcxConfig {
   port: number;
```

```diff
   /** One-time migration marker for Antigravity's static catalog default. */
   googleAntigravityStaticCatalogVersion?: 1;
   /** Claude Code inbound + launcher settings. */
   claudeCode?: OcxClaudeCodeConfig;
+  /**
+   * The user's durable ON/OFF intent for each client integration, separate from
+   * whatever config happens to be present on disk right now.
+   *
+   * Missing entries deliberately mean ON. Existing installations pre-date this
+   * map, and treating absence as OFF would silently unplug working clients on the
+   * first upgraded start — the same restart path that currently resurrects a Grok
+   * fence after its shipped switch removed it.
+   */
+  clientIntegrations?: Partial<Record<ClientIntegrationId, boolean>>;
   /**
    * Up to 5 routed model ids ("<provider>/<model>") to feature FIRST in the injected Codex catalog.
```

MODIFY `src/config.ts`. The parser salvages each known key independently. A
single hand-edited `"codex": "false"` becomes absent/ON, but it cannot discard a
valid `"grok": false` next to it; unknown future keys pass through so an older
binary does not erase a newer client's intent on save.

```diff
 import {
   isWirePinnedModel,
   MODEL_ADAPTER_OVERRIDE_ALLOWED,
   OPENAI_PROVIDER_TIER_VERSION,
   pinnedWireAdapter,
   REASONING_SUMMARY_DELIVERY_VALUES,
+  type ClientIntegrationId,
   type OcxClaudeCodeConfig,
   type OcxConfig,
```

```diff
 const apiKeyEntrySchema = z.object({
   key: z.string().refine(isUsableApiKeySecret),
   // Degrades to "" here; every schema consumer then runs `normalizeApiKeyIds`,
   // which fills it deterministically so the id is stable across loads.
   id: z.string().catch(""),
   name: z.string().catch(""),
   createdAt: z.string().catch(""),
 }).passthrough();

+const clientIntegrationsSchema = z.object({
+  codex: z.boolean().optional().catch(undefined),
+  "claude-code": z.boolean().optional().catch(undefined),
+  "claude-desktop": z.boolean().optional().catch(undefined),
+  grok: z.boolean().optional().catch(undefined),
+  opencode: z.boolean().optional().catch(undefined),
+  pi: z.boolean().optional().catch(undefined),
+  hermes: z.boolean().optional().catch(undefined),
+  openclaw: z.boolean().optional().catch(undefined),
+  kimi: z.boolean().optional().catch(undefined),
+  gajae: z.boolean().optional().catch(undefined),
+}).passthrough();
+
 const configSchema = z.object({
   port: z.number().int().min(0).max(65535).default(10100),
```

```diff
   googleAntigravityStaticCatalogVersion: z.literal(1).optional().catch(undefined),
+  // Per-key catches preserve every valid OFF beside one malformed hand edit. A
+  // malformed whole map degrades to absent, which is the upgrade-safe ON default.
+  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
   providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
```

Add the only effective-state reader beside the existing config feature gates
(`websocketsEnabled`, currently line 1909). No caller may open-code
`?.[client] ?? true`: Claude Code's old field is the transition exception.

```diff
 export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
   return config.websockets === true;
 }

+/**
+ * Resolve durable client intent without mistaking an absent upgrade-era key for
+ * an opt-out. Claude Code alone predates the shared map, so its old explicit OFF
+ * remains authoritative until a route has mirrored both representations.
+ */
+export function clientIntegrationEnabled(
+  config: Pick<OcxConfig, "clientIntegrations" | "claudeCode">,
+  client: ClientIntegrationId,
+): boolean {
+  const desired = config.clientIntegrations?.[client];
+  if (desired !== undefined) return desired !== false;
+  if (client === "claude-code") return config.claudeCode?.enabled !== false;
+  return true;
+}
+
+/** Write the transition representation in one place so Claude OFF cannot split-brain. */
+export function setClientIntegrationEnabled(
+  config: OcxConfig,
+  client: ClientIntegrationId,
+  enabled: boolean,
+): void {
+  config.clientIntegrations = { ...config.clientIntegrations, [client]: enabled };
+  if (client === "claude-code") {
+    config.claudeCode = { ...(config.claudeCode ?? {}), enabled };
+  }
+}
+
 // ---------------------------------------------------------------------------
 // Hand-edit protection for the `claudeCode` subtree (devlog 260726_claude_auth_auto/040 H1).
```

Truth table:

| New key | Legacy `claudeCode.enabled` | Effective state |
|---|---:|---:|
| absent | absent / `true` | ON |
| absent | `false` | OFF |
| `true` | any | ON |
| `false` | any | OFF |

The new key wins once present. Both Claude mutation routes write both, so the
legacy fallback can never migrate an existing Claude OFF back to ON.

## Gate 1 — Codex's shared sync owner

MODIFY `src/codex/sync.ts`. The return is a successful no-op because desired OFF
is policy, not a failed catalog refresh. The gate precedes the external-provider
branch too; that branch still calls `injectCodexConfig` (`sync.ts:56-70`).

```diff
-import { applyProxyEnv, loadConfig } from "../config";
+import { applyProxyEnv, clientIntegrationEnabled, loadConfig } from "../config";
```

```diff
 export async function syncModelsToCodex(
   port?: number,
   config: OcxConfig = loadConfig(),
   log: Pick<Console, "log" | "error"> | null = console,
   deps: CodexSyncDeps = defaultDeps,
 ): Promise<CodexSyncResult> {
+  if (!clientIntegrationEnabled(config, "codex")) {
+    return {
+      ok: true,
+      added: 0,
+      catalogPath: null,
+      catalogExists: false,
+      catalogWritten: false,
+      cacheSynced: false,
+      message: "Codex integration sync skipped: desired state is OFF.",
+    };
+  }
   const p = port ?? config.port ?? 10100;
```

This one gate covers `ocx start`, both `ocx ensure` branches, `POST /api/sync`,
`ocx sync`, `ocx restore back`, custom-model edits, and the direct CLI provider
sync caller (`src/cli/index.ts:318-341,365-411,756-829`,
`src/cli/models.ts:102-206`, `src/cli/provider.ts:235`).

## Gate 2 — provider/model catalog refreshes that bypass sync

MODIFY `src/server/management-api.ts`. `refreshCodexCatalogBestEffort` directly
calls `refreshCodexModelCatalog` today (`management-api.ts:105-112`), so putting
the check only in `syncModelsToCodex` leaves every provider/model/combo mutation
able to rewrite Codex artifacts.

```diff
 import {
   DEFAULT_SUBAGENT_MODELS,
+  clientIntegrationEnabled,
   codexAutoStartEnabled,
```

```diff
   async function refreshCodexCatalogBestEffort(): Promise<void> {
+    if (!clientIntegrationEnabled(config, "codex")) return;
     if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
     try {
       const { refreshCodexModelCatalog } = await import("../codex/refresh");
       await refreshCodexModelCatalog(config);
```

The gate comes before the injected dependency. Otherwise tests can pass while a
production caller bypasses policy through a configured seam.

## Gate 3 — every Grok startup/ensure caller

MODIFY `src/grok/sync.ts`, before catalog fetch and before the writer. Do not add
`"disabled"` to `GrokInjectResult.skippedReason`: those values are writer policy
outcomes from `injectGrokConfig`; desired OFF never reaches that writer.

```diff
 import { visibleNativeSlugs, filterCatalogVisibleModels, nativeOpenAiContextWindow, type CatalogModel } from "../codex/catalog";
+import { clientIntegrationEnabled } from "../config";
 import type { OcxConfig } from "../types";
```

```diff
 export async function syncGrokConfig(
   port: number,
   config: OcxConfig,
   opts: { hostname?: string; grokHome?: string } = {},
   deps: GrokSyncDeps = { fetchAllModels: defaultFetchAllModels, injectGrokConfig },
 ): Promise<GrokInjectResult> {
+  if (!clientIntegrationEnabled(config, "grok")) {
+    return {
+      ok: true,
+      changed: false,
+      message: "Grok config sync skipped: desired state is OFF.",
+    };
+  }
   let models: GrokInjectModel[];
```

This closes all three real callers: start and both ensure branches
(`src/cli/index.ts:334-341,372-379,398-404`) plus `/api/grok/apply`, whose flight
loads fresh persisted config before calling this helper
(`src/server/management/agent-settings-routes.ts:94-107,639-652`).

## Gate 4 — Desktop auto-apply is two policies, not one

MODIFY `src/server/management/agent-settings-routes.ts`. Desktop desired state
and `desktopAutoApply` answer different questions: “may opencodex manage Desktop?”
and “may provider changes rewrite the saved managed profile?” Both must allow the
write.

```diff
 import {
   DEFAULT_SUBAGENT_MODELS,
+  clientIntegrationEnabled,
   codexAutoStartEnabled,
```

```diff
   /** Best-effort Desktop 3P config auto-reconcile when providers change. */
   async function autoApplyDesktopBestEffort(): Promise<void> {
     try {
+      if (!clientIntegrationEnabled(config, "claude-desktop")) return;
       if (config.claudeCode?.desktopAutoApply === false) return;
       if (!config.claudeCode?.desktopProfile) return;
```

An absent desired key and absent `desktopAutoApply` both preserve the current
auto-apply behavior. `desktopAutoApply: false` must never be migrated into
Desktop desired OFF (`003_durable_desired_state.md:106-115`).

## Gate 5 — `ocx opencode` cannot inject around disk state

MODIFY `src/cli/opencode.ts`. The command builds `OPENCODE_CONFIG_CONTENT`, whose
provider block outranks global, project, and custom disk config
(`opencode.ts:461-477`). INFERRED decision: an explicit invocation while desired
OFF refuses with exit 1, matching `ocx claude`; launching an unwired OpenCode from
a command whose contract says “wired to the local proxy” would be a false green.

```diff
-import { loadConfig } from "../config";
+import { clientIntegrationEnabled, loadConfig } from "../config";
```

```diff
 export async function cmdOpencode(args: string[]): Promise<number> {
   const config = loadConfig();
+  if (!clientIntegrationEnabled(config, "opencode")) {
+    console.error("OpenCode integration is disabled (config.clientIntegrations.opencode=false — turn it ON before using `ocx opencode`).");
+    return 1;
+  }
   const live = await ensureProxyForOpencode(config);
```

The gate precedes `ensureProxyForOpencode`; a disabled client command must not
start the proxy merely to refuse later.

## Claude Code transition consumers

The new map is authoritative when present; mirroring is compatibility, not a
license for old consumers to open-code the legacy field forever. Replace the
three Claude-Code-specific automatic gates and the management agent-sync gate.

MODIFY `src/cli/claude.ts`:

```diff
-import { loadConfig } from "../config";
+import { clientIntegrationEnabled, loadConfig } from "../config";
```

```diff
 export async function cmdClaude(args: string[]): Promise<number> {
   const config = loadConfig();
-  if (config.claudeCode?.enabled === false) {
-    console.error("Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).");
+  if (!clientIntegrationEnabled(config, "claude-code")) {
+    console.error("Claude Code integration is disabled — turn it ON before using `ocx claude`.");
     return 1;
   }
```

MODIFY `src/claude/agents-inject.ts`:

```diff
-import { DEFAULT_SUBAGENT_MODELS, hasOwnProvider } from "../config";
+import { clientIntegrationEnabled, DEFAULT_SUBAGENT_MODELS, hasOwnProvider } from "../config";
```

```diff
 export function injectClaudeAgentDefs(config: OcxConfig, windows: Record<string, number>, configDir?: string): string[] | null {
-  if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
+  if (!clientIntegrationEnabled(config, "claude-code") || config.claudeCode?.injectAgents === false) {
```

MODIFY `src/server/system-env.ts`:

```diff
-import { getConfigDir } from "../config";
+import { clientIntegrationEnabled, getConfigDir } from "../config";
```

```diff
 export async function injectSystemEnv(port: number, config: OcxConfig): Promise<SystemEnvResult> {
   if (process.platform !== "darwin") return { injected: false, reason: "not macOS" };
-  if (config.claudeCode?.enabled === false) return { injected: false, reason: "claude disabled" };
+  if (!clientIntegrationEnabled(config, "claude-code")) return { injected: false, reason: "claude disabled" };
```

MODIFY the already-open `src/server/management-api.ts` import above, then:

```diff
   async function syncClaudeAgentDefsBestEffort(): Promise<void> {
     try {
       const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
-      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
+      if (!clientIntegrationEnabled(config, "claude-code") || config.claudeCode?.injectAgents === false) {
```

## Persist desired intent before the Grok mutation

MODIFY `src/server/management/native-integration-routes.ts`. The config write is
the intent commit; fence inspection/removal/injection is observation and may
refuse. Never roll the committed flag back because the file conflicted.

```diff
-import { readRuntimePort, saveConfigPreservingClaudeCode } from "../../config";
+import { clientIntegrationEnabled, readRuntimePort, saveConfigPreservingClaudeCode, setClientIntegrationEnabled } from "../../config";
```

The response must keep the two states separate. `state` remains observed disk
state for compatibility; `desiredEnabled` is the persisted intent.

```diff
 export interface NativeStatus {
   clientId: NativeIntegrationClientId;
   state: "absent" | "current" | "unsafe";
+  desiredEnabled: boolean;
   installed: boolean;
```

```diff
 export interface NativeToggleEnvelope {
   ok: true;
   clientId: NativeIntegrationClientId;
   changed: boolean;
   state: NativeStatus["state"];
+  desiredEnabled: boolean;
   message: string;
```

```diff
 export interface NativeRefusalEnvelope {
   error: string;
   code: "native_integration_refused" | "native_integration_failed";
   clientId: NativeIntegrationClientId;
   reason: NativeRefusalReason;
   message: string;
+  desiredEnabled?: boolean;
+  observedState?: NativeStatus["state"];
 }
```

Change `claudeCodeEnabled` into a compatibility alias and report desired state
from both GET rows:

```diff
 /** Absent means ON: the six read sites all treat only an explicit `false` as off. */
 export function claudeCodeEnabled(config: ManagementContext["config"]): boolean {
-  return config.claudeCode?.enabled !== false;
+  return clientIntegrationEnabled(config, "claude-code");
 }
```

```diff
   return {
     clientId: "claude",
     state: claudeCodeEnabled(config) ? "current" : "absent",
+    desiredEnabled: claudeCodeEnabled(config),
```

```diff
-function grokStatus(): NativeStatus {
+function grokStatus(config: ManagementContext["config"]): NativeStatus {
   const seen = inspectGrokConfig();
```

```diff
   return {
     clientId: "grok",
     state,
+    desiredEnabled: clientIntegrationEnabled(config, "grok"),
     installed: seen.kind !== "not_installed",
```

```diff
   if (url.pathname === "/api/native-integrations" && req.method === "GET") {
     const { getConfigPath } = await import("../../config");
     return jsonResponse({
-      clients: [claudeStatus(config, getConfigPath()), grokStatus()],
+      clients: [claudeStatus(config, getConfigPath()), grokStatus(config)],
```

In `handleGrokToggle`, persist immediately after body validation and before the
first inspector. If config persistence fails, do not touch the Grok file; that is
the only failure allowed to prevent the desired-state commit.

```diff
     }
     const enabled = body.enabled;
+    if (config.clientIntegrations?.grok !== enabled) {
+      const previousClientIntegrations = config.clientIntegrations;
+      setClientIntegrationEnabled(config, "grok", enabled);
+      const persist = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
+      try {
+        persist(config);
+      } catch (error) {
+        if (previousClientIntegrations === undefined) delete config.clientIntegrations;
+        else config.clientIntegrations = previousClientIntegrations;
+        if (isConfigLockError(error)) {
+          return isLockContention(error)
+            ? refusal(409, "grok", "config_busy",
+                "Another process is saving the configuration right now. Desired state was not changed; try again in a moment.")
+            : refusal(500, "grok", "write_failed",
+                `Desired state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
+        }
+        throw error;
+      }
+    }

     /*
      * The inspector runs BEFORE either delegate, in BOTH directions (012 §In
```

Every success envelope in this function adds `desiredEnabled: enabled`. Every
post-persist refusal adds `desiredEnabled: enabled` and the last observed state.
The ownership refusal is the regression case:

```diff
       const owned = assertNativeTeardownOwned();
-      if (!owned.ok) return refusal(409, "grok", "home_mismatch", owned.message);
+      if (!owned.ok) {
+        return jsonResponse({
+          error: "native integration change refused",
+          code: "native_integration_refused",
+          clientId: "grok",
+          reason: "home_mismatch",
+          desiredEnabled: false,
+          observedState: "current",
+          message: `${owned.message} Desired OFF was saved; the observed Grok block is still present.`,
+        } satisfies NativeRefusalEnvelope, 409);
+      }
```

Apply the same shape to orphaned-marker, late writer refusal, and catalog failure:
desired remains what was saved; `observedState` comes from the inspector rather
than from the requested direction. The route may say “desired OFF, observed
conflict”; it must never answer “still ON” as though the request disappeared.

## Mirror Claude Code during transition

The native route currently skips persistence when legacy effective state already
matches (`native-integration-routes.ts:393-400`). That is no longer enough: an
old `{ claudeCode: { enabled: false } }` must acquire the new false key even
though its effective state is already OFF.

```diff
     const enabled = body.enabled;
-    if (claudeCodeEnabled(config) === enabled) {
+    const alreadyMirrored = config.clientIntegrations?.["claude-code"] === enabled
+      && config.claudeCode?.enabled === enabled;
+    if (alreadyMirrored) {
       return jsonResponse({
         ok: true, clientId: "claude", changed: false,
         state: enabled ? "current" : "absent",
+        desiredEnabled: enabled,
```

```diff
-    const next = { ...(config.claudeCode ?? {}), enabled };
+    setClientIntegrationEnabled(config, "claude-code", enabled);
+    const next = config.claudeCode!;
```

All native Claude success envelopes add `desiredEnabled: enabled`.

The older `/api/claude-code` route in
`src/server/management/agent-settings-routes.ts` already persists the legacy
field (`agent-settings-routes.ts:941,1060-1070`); mirror the map before that same
save rather than introducing a second write:

```diff
     }
     config.claudeCode = next;
     // Stamp the migration sentinel on EVERY persist of this block. The migration reads
@@
     // would be converted into a sticky manual subscription by the next startServer, and
     // auto would survive exactly one proxy lifetime with no way back.
     if (!next.authModeMigratedAt) next.authModeMigratedAt = new Date().toISOString();
+    if (body.enabled !== undefined) {
+      setClientIntegrationEnabled(config, "claude-code", next.enabled !== false);
+    }
     const { saveConfigPreservingClaudeCode: save } = await import("../../config");
```

Import `setClientIntegrationEnabled` from `../../config` in the existing import
block. The setter runs after the migration sentinel because it reassigns
`config.claudeCode`; this order guarantees the mirrored object is the stamped
object that the existing save persists.

## What must NOT be gated

| Surface | Required invariant |
|---|---|
| `src/codex/journal.ts:148-162` | `reconcileJournal` always repairs a dead process's stale Codex state. Desired OFF is not permission to leave a half-applied journal. |
| `src/integrations/writer.ts:171-223` | Path resolution, ownership, parse, drift, and compare-before-write checks always run when a mutation is requested. |
| `src/service.ts:2587-2594` | Stop restores native Codex and strips Grok's dead proxy pointer. It does not write `clientIntegrations`; stopping is not opting out. |
| `src/grok/inject.ts:359-380` | A non-loopback bind always strips the unsafe loopback fence, even when desired Grok state is ON. |
| `/v1/responses` | Codex desired OFF stops Codex config/catalog writes, not the Responses transport used by OpenCode, Pi, Hermes, OpenClaw, Kimi, and Gajae. |
| `/v1/messages` and `/v1/messages/count_tokens` | Claude Code/Desktop desired state stops client-specific wiring, not the Anthropic transport shared by both clients and external callers. |

The last invariant exposes an already-shipped contradiction. Today
`claudeCode.enabled=false` returns 403 from both Messages handlers
(`src/server/claude-messages.ts:65-69,536-548,868-872`) and empties shared
Anthropic model discovery (`src/server/index.ts:493-502`). Remove those gates;
do not replace them with `clientIntegrationEnabled`.

MODIFY `src/server/claude-messages.ts`:

```diff
-function claudeInboundDisabled(config: OcxConfig): Response | null {
-  if (config.claudeCode?.enabled === false) {
-    return anthropicErrorResponse(403, "Claude inbound is disabled (GUI: Claude ON toggle / config.claudeCode.enabled)", "permission_error");
-  }
-  return null;
-}
-
 async function readAnthropicBody(req: Request, budget: TranslatorBudget): Promise<unknown> {
```

```diff
 ): Promise<Response> {
   logCtx.surface = "claude";
-  const disabled = claudeInboundDisabled(config);
-  if (disabled) {
-    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 403, { closeReason: "non_stream" });
-    return disabled;
-  }

   let anthropicBody: unknown;
```

```diff
 /** Documented approximation: serialize system+messages+tools, run the char estimator. */
 export async function handleClaudeCountTokens(req: Request, config: OcxConfig): Promise<Response> {
-  const disabled = claudeInboundDisabled(config);
-  if (disabled) return disabled;
-
   let body: unknown;
```

MODIFY `src/server/index.ts`:

```diff
         const wantsAnthropicList = req.headers.get("anthropic-version") !== null
           || url.searchParams.get("flavor") === "anthropic";
         if (wantsAnthropicList && !url.searchParams.has("client_version")) {
-          if (config.claudeCode?.enabled === false) return jsonResponse({ data: [] }, 200, req, config);
           // Build Desktop 3P registry so inbound alias resolution works for subsequent requests.
```

## Test plan

### `tests/client-integration-desired-state.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| Absent-config upgrade | Load a config with no `clientIntegrations`; every id is effective ON. This is C3's upgrade case, not merely a helper call with a fabricated object. |
| Missing key / explicit true / explicit false | For every id: absent and true are ON; only false is OFF. |
| Claude legacy fallback | New key absent + `claudeCode.enabled=false` is OFF; absent/true is ON. |
| New Claude key wins | New true overrides legacy false, and new false overrides legacy true. |
| Per-key malformed salvage | Persist `{ codex: "false", grok: false }`; load yields Codex ON and Grok OFF, without falling back to a default config or losing providers. |
| Future-key preservation | An unknown boolean key survives load/save so an older binary does not erase a newer client's intent. |
| Setter mirroring | `setClientIntegrationEnabled(..., "claude-code", value)` writes both keys and preserves every unrelated Claude field. Other ids touch only the map. |

### `tests/client-integration-auto-gates.test.ts` (NEW)

| Gate | Activation and observable proof |
|---|---|
| Codex sync OFF | Inject spies for catalog refresh and `injectCodexConfig`; both remain at zero, including the external-provider branch. Result is the explicit successful skip. |
| Codex absent/ON | The same spies fire, pinning upgrade behavior. |
| Direct management refresh OFF | Trigger a provider and a custom-model route with `refreshCodexCatalog` injected; count stays zero. This proves the bypass gate, not `syncModelsToCodex`. |
| Grok sync OFF | Inject fetch and writer spies; neither fires. Repeat with no map and prove both fire. |
| Desktop two-key gate | Exercise provider mutation with a saved Desktop profile for all four combinations of desired ON/OFF and `desktopAutoApply` true/false; write occurs only when both policies allow it. |
| OpenCode OFF | Invoke the command through injectable launch seams; proxy ensure, catalog fetch, env build, and spawn remain uncalled, exit is 1. |
| Claude compatibility consumers | New-map false with legacy field absent blocks launcher/system-env/agent writes; absent new key + legacy false does the same. |

### Route regressions

MODIFY `tests/native-grok-toggle.test.ts`:

1. Disable persists `clientIntegrations.grok=false` before `stripGrokConfig`.
2. Ownership refusal leaves that persisted false and returns
   `desiredEnabled:false`, `observedState:"current"`.
3. Orphaned fence, late writer refusal, and catalog failure keep the requested
   intent and report observed state; none rolls the flag back.
4. A config-lock failure calls neither strip nor inject and says desired state was
   not saved.
5. The next `syncGrokConfig` with the saved config calls neither catalog nor
   writer — the exact `ocx start` regression.

MODIFY `tests/native-claude-code-toggle.test.ts` and
`tests/claude-management-api.test.ts`: both routes mirror old/new values; an old
legacy OFF plus absent new key is not treated as a no-op; unrelated Claude fields
and the auth-mode migration sentinel survive.

### `tests/client-integration-transport-isolation.test.ts` (NEW)

Start the real Bun proxy with `clientIntegrations.codex=false` and
`clientIntegrations["claude-code"]=false`. Assert `/healthz` stays healthy;
an invalid `/v1/responses` request reaches its normal validation response rather
than an integration-disabled response; invalid `/v1/messages` and
`/v1/messages/count_tokens` requests return their normal 400 contract, never the
old 403. Fetch Anthropic model discovery and assert it is not emptied by Claude
Code OFF. This is the case proving a disabled client does not break another
client's transport.

MODIFY `tests/claude-messages-endpoint.test.ts:786-803` to remove the old test
that requires 403. Keeping it would encode the C4 violation as a regression.

## Verification

Static and suite gates:

```bash
bun test tests/client-integration-desired-state.test.ts
bun test tests/client-integration-auto-gates.test.ts
bun test tests/native-grok-toggle.test.ts tests/native-claude-code-toggle.test.ts tests/claude-management-api.test.ts
bun test tests/client-integration-transport-isolation.test.ts tests/claude-messages-endpoint.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Live proof uses the already-running proxy at `localhost:10100`; a green suite is
not restart persistence:

1. Record `curl -fsS http://localhost:10100/healthz` and its `pid`.
2. Through the authenticated dashboard/API, turn Grok OFF. Confirm
   `GET /api/native-integrations` reports `desiredEnabled:false` and observed
   `absent`, or the explicit observed conflict if ownership/drift refused removal.
3. Run `ocx ensure`, then re-read both the status and `~/.grok/config.toml`.
   Desired remains false and no managed fence reappears. Repeat after a real
   proxy restart; `/healthz` returns with a new PID and Grok remains OFF.
4. Turn Codex OFF in the WP5 surface, run `POST /api/sync` and one provider edit,
   then prove neither Codex config nor catalog artifact changed. `/healthz` remains
   healthy.
5. With Claude Code desired OFF, send an invalid body to both shared paths:

   ```bash
   curl -sS -o /tmp/ocx-messages-proof.json -w '%{http_code}\n' \
     -H 'content-type: application/json' -d '{}' \
     http://localhost:10100/v1/messages
   curl -sS -o /tmp/ocx-count-proof.json -w '%{http_code}\n' \
     -H 'content-type: application/json' -d '{}' \
     http://localhost:10100/v1/messages/count_tokens
   ```

   Both reach normal request validation (400), not integration policy (403).
   Read the bodies back; a status code without the response body is not proof of
   which branch ran.
6. Re-read `/healthz`; the proxy stayed serving throughout. Compare the PID with
   step 1 for the no-stop toggle operations and with the post-restart PID for the
   restart persistence case.

## Accept criteria

| Roadmap criterion | WP3 closure |
|---|---|
| C2 — disabled survives restart, ensure, and `/api/sync` | Grok OFF is persisted before mutation; the shared Grok sync and Codex sync/direct-refresh owners are gated. Tests activate each path, and live proof checks the real fence after ensure and restart. |
| C3 — absent config changes nothing on upgrade | The absent-map load test proves every integration effective ON; missing keys and explicit true remain ON. Claude's absent-key fallback preserves a legacy explicit OFF. |
| C4 — disable never stops proxy or another transport | No lifecycle path is touched. Journal, teardown, credential cleanup, `/v1/responses`, and `/v1/messages` remain unconditional; the existing Claude transport/model-discovery gates are removed and the real proxy isolation test proves reachability. |

WP3 is complete only when desired and observed state can disagree honestly. A
successful file removal with no persisted flag is still the shipped Grok bug; a
persisted OFF reported as observed OFF when the file is still present is a new
lie, not a fix.
