# WP3 — durable desired state, admission, and convergence

Research: `003_durable_desired_state.md`. Audit disposition:
`005_audit_synthesis.md`. Read both first; this doc is the amended diff.

The shipped Grok switch removes its fence but records no intent. The next
`ocx start` calls `syncGrokConfig` and writes the fence back
(`src/cli/index.ts:334-350`, `src/grok/sync.ts:29-65`). The failed first draft
added a boolean but omitted the writers, ordering, and restart work that make the
boolean govern the system. It also proposed removing Claude's shipped ingress
kill switch. That decision is reversed here, plainly: the audit was right. An
upgrading user with legacy `claudeCode.enabled=false` must not silently regain
Claude ingress.

WP3 therefore owns more than a flag. It owns the shared desired-state contract,
field-scoped persistence, the per-client operation boundary, the six file-client
writer, startup reconciliation, and the response grammar WP5 and WP6 consume.

## IN / OUT

| Path | Change | Why it is in WP3 |
|---|---|---|
| `src/types.ts` | MODIFY | Defines the complete ten-client desired-state vocabulary and `OcxConfig.clientIntegrations`. |
| `src/config.ts` | MODIFY | Parses the map, resolves legacy Claude intent, and mutates one selected key through the existing `mutatePersistedConfig` primitive. |
| `src/integrations/desired-state.ts` | NEW | Owns per-client single-flight, last-moment persisted-state checks, and reconciliation result types. |
| `src/integrations/reconcile.ts` | NEW | Converges desired OFF to observed absent for the six file clients and the native handlers registered by WP3/WP5/WP6. |
| `src/integrations/state.ts` | MODIFY | Adds required `desiredEnabled` to the six-client status helper. |
| `src/integrations/writer.ts` | MODIFY | Re-reads persisted intent immediately before apply/disable/restore commits. |
| `src/server/management/integration-routes.ts` | MODIFY | Persists the six-client desired state before applying/removing files; GET/status also reconciles stale OFF. |
| `src/codex/sync.ts` | MODIFY | Stops Codex catalog/injection while OFF, joins the per-client flight, and re-checks before each artifact write. |
| `src/grok/sync.ts` | MODIFY | Stops Grok fetch/write while OFF, joins the same Grok flight as every other caller, and re-checks before injection. |
| `src/server/management-api.ts` | MODIFY | Gates the direct Codex catalog refresher and moves Claude agent sync to the compatibility helper. |
| `src/server/management/native-integration-routes.ts` | MODIFY | Owns the complete four-client native contract, field-scoped Claude/Grok persistence, status helpers, and native reconciliation entry points. |
| `src/server/management/agent-settings-routes.ts` | MODIFY | Routes Grok/Desktop background writes through the shared flight and mutation contract. |
| `src/cli/index.ts` | MODIFY | Runs OFF reconciliation on start and both ensure branches before any automatic apply. |
| `src/cli/opencode.ts` | MODIFY | Refuses the inline provider writer after a real OpenCode OFF and re-checks before spawn. |
| `src/cli/claude.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/claude/agents-inject.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/server/system-env.ts` | MODIFY | Reads Claude Code desired state through the compatibility helper. |
| `src/server/claude-messages.ts` | MODIFY | Keeps both shipped Claude ingress gates and changes only their reader to `clientIntegrationEnabled`. |
| `src/server/index.ts` | MODIFY | Keeps Anthropic discovery gated and changes only its reader to `clientIntegrationEnabled`. |
| `tests/client-integration-desired-state.test.ts` | NEW | Pins migration, per-field mutation, contention/retry, and preservation. |
| `tests/client-integration-auto-gates.test.ts` | NEW | Pins automatic gates, shared flights, last-moment re-checks, and OpenCode activation. |
| `tests/client-integration-reconciliation.test.ts` | NEW | Pins persist/mutate crash points and startup/ensure/status convergence. |
| `tests/management-integration-routes.test.ts` | MODIFY | Pins the six-client persist-before-mutate route and desired/observed responses. |
| `tests/native-grok-toggle.test.ts` | MODIFY | Pins field-scoped persistence, conflict reporting, and retry after lock refusal. |
| `tests/native-claude-code-toggle.test.ts` | MODIFY | Replaces the pinned live-object mutation bug with no-mutation-before-commit coverage. |
| `tests/claude-management-api.test.ts` | MODIFY | Pins compatibility mirroring through the older Claude route. |
| `tests/claude-messages-endpoint.test.ts` | MODIFY | Keeps the legacy OFF => 403 contract through the new reader. |

OUT:

| Path / surface | Reason |
|---|---|
| `gui/` | WP3 adds the contract, not a new card. WP5 and WP6 consume it. |
| `src/codex/journal.ts` | Crash reconciliation repairs a half-applied Codex write regardless of desired state (`src/codex/journal.ts:148-162`). |
| `src/service.ts` stop/uninstall teardown | Teardown removes dead proxy pointers; it neither consults nor rewrites desired state (`src/service.ts:2587-2594`). |
| `src/grok/inject.ts` non-loopback cleanup | Credential-safety cleanup remains unconditional (`src/grok/inject.ts:359-380`). |
| `/v1/responses` | No client-specific gate guards it today. Codex OFF must not close the transport used by other clients. |
| Codex/Desktop remover implementations | WP5 and WP6 implement those two removers against this contract. Their shared-file work is sequential, not parallel. |
| releases, publishing, deploys, tags, repository starring | No delivery or user-identity action belongs in this phase. |

## The schema and effective-state reader

MODIFY `src/types.ts` immediately before `OcxConfig` (`src/types.ts:521-533`),
then put the field beside `claudeCode` (`src/types.ts:541-545`):

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
```

```diff
   /** Claude Code inbound + launcher settings. */
   claudeCode?: OcxClaudeCodeConfig;
+  /** Durable user intent. Missing map/key means ON for upgrade compatibility. */
+  clientIntegrations?: Partial<Record<ClientIntegrationId, boolean>>;
```

MODIFY `src/config.ts`. The parser salvages each known key independently. A
hand-edited `"codex": "false"` becomes absent/ON without discarding a valid
`"grok": false` beside it. The object stays `.passthrough()` so an older binary
does not erase a newer client's key on its next field-scoped mutation.

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
```

```diff
   googleAntigravityStaticCatalogVersion: z.literal(1).optional().catch(undefined),
+  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
   providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
```

Add the only effective-state reader beside `websocketsEnabled`
(`src/config.ts:1909-1911`). No caller may open-code `?.[client] ?? true` because
Claude Code's old field is the migration exception.

```diff
 export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
   return config.websockets === true;
 }

+export function clientIntegrationEnabled(
+  config: Pick<OcxConfig, "clientIntegrations" | "claudeCode">,
+  client: ClientIntegrationId,
+): boolean {
+  const desired = config.clientIntegrations?.[client];
+  if (desired !== undefined) return desired !== false;
+  if (client === "claude-code") return config.claudeCode?.enabled !== false;
+  return true;
+}
```

Truth table:

| New key | Legacy `claudeCode.enabled` | Effective state |
|---|---:|---:|
| absent | absent / `true` | ON |
| absent | `false` | OFF |
| `true` | any | ON |
| `false` | any | OFF |

## A2 — field-scoped persistence uses the primitive that already exists

The failed draft invented `saveConfigPreservingClaudeCode` as the desired-state
writer and mutated the request's live `config` before saving it. The shipped
Claude route still demonstrates the bug: it assigns `config.claudeCode = next`
at `src/server/management/native-integration-routes.ts:402-415`, then persistence
can refuse at `:420-431`. The regression test explains why a retry needs a fresh
object (`tests/native-claude-code-toggle.test.ts:213-218`).

Do not add that writer. `mutatePersistedConfig` already has the required real
contract (`src/config.ts:1825-1832,1854-1906`):

```ts
export function mutatePersistedConfig<T>(
  mutate: (config: OcxConfig) => { changed: boolean; value: T },
):
  | { status: "committed" | "unchanged"; value: T }
  | { status: "unavailable"; reason: "missing" | "invalid" | "conflict" };
```

It reads the current disk bytes, clones before invoking the callback, re-runs the
callback against the latest snapshot, and commits the confirmed clone under the
shared SQLite mutation lock. Build the one-key mutation on top of that signature:

```diff
+export interface ClientIntegrationMutationValue {
+  config: OcxConfig;
+  desiredEnabled: boolean;
+}
+
+export function mutateClientIntegrationEnabled(
+  client: ClientIntegrationId,
+  enabled: boolean,
+): PersistedConfigMutationOutcome<ClientIntegrationMutationValue> {
+  return mutatePersistedConfig(config => {
+    const mapAlreadyMatches = config.clientIntegrations?.[client] === enabled;
+    const legacyAlreadyMatches = client !== "claude-code"
+      || config.claudeCode?.enabled === enabled;
+    if (mapAlreadyMatches && legacyAlreadyMatches) {
+      return { changed: false, value: { config, desiredEnabled: enabled } };
+    }
+    config.clientIntegrations = { ...config.clientIntegrations, [client]: enabled };
+    if (client === "claude-code") {
+      config.claudeCode = { ...(config.claudeCode ?? {}), enabled };
+    }
+    return { changed: true, value: { config, desiredEnabled: enabled } };
+  });
+}
```

Only the callback-local clone is mutated. A route uses `outcome.value.config` for
the following file operation; it does not patch `ctx.config` before or after the
commit. A later status read loads persisted state. This prevents one long-lived
request object from overwriting a newer disk edit and makes lock refusal retryable
with the same object.

The helper touches only `clientIntegrations[client]`, plus
`claudeCode.enabled` for the one compatibility client. It preserves all other
client keys, providers, API settings, and unrelated `claudeCode` fields.

Required persistence tests:

1. Two writers toggling different clients from the same stale starting object
   both survive in the final file.
2. Simultaneous toggles of different clients preserve both keys; simultaneous
   opposing toggles of one client serialize to one whole outcome, never a split
   legacy/new representation.
3. A held mutation lock refuses without changing the live object; retry with the
   same object succeeds after release.
4. Claude mirroring preserves `authMode`, `injectAgents`, `desktopProfile`,
   `desktopAutoApply`, and unknown hand-edited Claude fields.

## A1 reversal — keep client-specific Claude ingress admission

The earlier invariant was over-broad. Client installation state must not stop the
proxy or a different client, but ingress admission is itself a client contract.
`claudeCode.enabled` is the documented, shipped kill switch used before body work
for `/v1/messages` and `/v1/messages/count_tokens`
(`src/server/claude-messages.ts:65-69,543-548,868-872`) and before Anthropic model
discovery (`src/server/index.ts:493-502`). Removing those checks would turn a
legacy OFF into ON during upgrade.

KEEP every gate and change only the reader:

```diff
+import { clientIntegrationEnabled } from "../config";
@@
 function claudeInboundDisabled(config: OcxConfig): Response | null {
-  if (config.claudeCode?.enabled === false) {
+  if (!clientIntegrationEnabled(config, "claude-code")) {
     return anthropicErrorResponse(403, "Claude inbound is disabled (GUI: Claude ON toggle / config.claudeCode.enabled)", "permission_error");
   }
   return null;
 }
```

```diff
         const wantsAnthropicList = req.headers.get("anthropic-version") !== null
           || url.searchParams.get("flavor") === "anthropic";
         if (wantsAnthropicList && !url.searchParams.has("client_version")) {
-          if (config.claudeCode?.enabled === false) return jsonResponse({ data: [] }, 200, req, config);
+          if (!clientIntegrationEnabled(config, "claude-code")) {
+            return jsonResponse({ data: [] }, 200, req, config);
+          }
```

The corrected invariant is precise:

| Surface | Desired OFF behavior |
|---|---|
| Codex `/v1/responses` | Remains admitted. No Codex client gate guarded this transport. |
| Claude Code `/v1/messages` and `/count_tokens` | Returns the shipped 403 because this is Claude Code ingress admission. |
| Anthropic-flavored model discovery | Returns an empty list while Claude Code is OFF, preserving the shipped kill switch. |
| Proxy lifecycle | Remains running. No toggle calls stop/restart/uninstall. |
| A different client's writer/transport | Remains available unless that different client's own desired key is OFF. |

Compatibility activation: load a legacy file containing only
`claudeCode.enabled=false`, run the migration/load path with no new key, then hit
both Messages handlers and Anthropic discovery. Both handlers still return 403
and discovery still returns `{ data: [] }`. This test must fail if either old
gate is removed.

## A6 — the complete shared native contract, consumed rather than redefined

The first roadmap dispatched WP5 and WP6 in parallel even though both edit
`native-integration-routes.ts` and its client union. Their proposed unions do not
compose: one adds Codex and the other adds Desktop. WP3 defines the final contract
once. WP5 runs first where shared files overlap; WP6 rebases on WP5 and runs
second. They may proceed independently only on disjoint files.

MODIFY `src/server/management/native-integration-routes.ts:31-74`:

```diff
-export type NativeIntegrationClientId = "claude" | "grok";
+export type NativeIntegrationClientId =
+  | "codex"
+  | "claude"
+  | "claude-desktop"
+  | "grok";
@@
 export interface NativeStatus {
   clientId: NativeIntegrationClientId;
   state: "absent" | "current" | "unsafe";
+  desiredEnabled: boolean;
   installed: boolean;
@@
 export interface NativeToggleEnvelope {
   ok: true;
   clientId: NativeIntegrationClientId;
   changed: boolean;
   state: NativeStatus["state"];
+  desiredEnabled: boolean;
   message: string;
@@
 export interface NativeRefusalEnvelope {
   error: string;
   code: "native_integration_refused" | "native_integration_failed";
   clientId: NativeIntegrationClientId;
   reason: NativeRefusalReason;
   message: string;
+  desiredEnabled: boolean;
+  observedState?: NativeStatus["state"];
+  residualPaths?: string[];
 }
```

The status helpers own the native-id mapping and make omission a type error:

```diff
+function desiredClientId(clientId: NativeIntegrationClientId): ClientIntegrationId {
+  return clientId === "claude" ? "claude-code" : clientId;
+}
+
+function desiredEnabledForNative(
+  config: Pick<OcxConfig, "clientIntegrations" | "claudeCode">,
+  clientId: NativeIntegrationClientId,
+): boolean {
+  return clientIntegrationEnabled(config, desiredClientId(clientId));
+}
+
+function withDesiredState(
+  config: Pick<OcxConfig, "clientIntegrations" | "claudeCode">,
+  observed: Omit<NativeStatus, "desiredEnabled">,
+): NativeStatus {
+  return {
+    ...observed,
+    desiredEnabled: desiredEnabledForNative(config, observed.clientId),
+  };
+}
```

`claudeStatus`, `grokStatus`, and later `codexStatus`/`desktopStatus` return through
`withDesiredState`. Every success literal supplies `desiredEnabled`; every refusal
uses a single serializer that supplies the persisted intent and, after persistence,
the last observed state. WP5 and WP6 delete their local union/schema diffs and use
these helpers.

The six file-client schema follows the same two-state rule. MODIFY
`src/integrations/state.ts:30-42` and the route envelopes at
`src/server/management/integration-routes.ts:44-55`:

```diff
 export interface IntegrationStatus {
   clientId: IntegrationClientId;
   state: IntegrationState;
+  desiredEnabled: boolean;
   installed: boolean;
```

```diff
-export type IntegrationToggleEnvelope =
-  | ({ clientId: IntegrationClientId } & ApplyResult)
-  | ({ clientId: IntegrationClientId } & DisableResult);
+export type IntegrationToggleEnvelope = (
+  | ({ clientId: IntegrationClientId } & ApplyResult)
+  | ({ clientId: IntegrationClientId } & DisableResult)
+) & { desiredEnabled: boolean };
```

`readIntegrationState` is the status helper every surface already uses
(`src/integrations/state.ts:225-289`); add
`desiredEnabled: clientIntegrationEnabled(input.config, input.clientId)` to all
three return sites, including unsafe path-resolution and unreadable-file returns.

## A3 — six file clients persist intent before touching their files

The failed draft put `ocx opencode` behind a desired-state guard but gave
OpenCode, Pi, Hermes, OpenClaw, Kimi, and Gajae no writer for that state. The
real switch is `PUT /api/client-integrations/:clientId`, which currently goes
straight from body validation to `applyIntegration`/`disableIntegration`
(`src/server/management/integration-routes.ts:507-527`). Route it through the same
field-scoped mutation first:

```diff
   const parsed = await readJsonBody(ctx);
   if (parsed instanceof Response) return parsed;
@@
   try {
+    const persisted = mutateClientIntegrationEnabled(requestedClient, parsed.enabled);
+    if (persisted.status === "unavailable") {
+      return desiredStatePersistenceFailure(requestedClient, persisted.reason, ctx);
+    }
+    const operationConfig = persisted.value.config;
-    const input = await buildIntegrationWriteInput(requestedClient, ctx, integrationStore());
+    const input = await buildIntegrationWriteInput(
+      requestedClient,
+      ctx,
+      integrationStore(),
+      operationConfig,
+    );
     const result = await runClientIntegrationFlight(
       requestedClient,
       parsed.enabled ? "apply" : "disable",
-      input.io?.now ?? Date.now,
       () => Promise.resolve(parsed.enabled
         ? applyIntegration(input)
         : disableIntegration(input)),
     );
-    if (!result.ok) return writerFailureResponse(requestedClient, result, ctx);
-    return jsonResponse(result satisfies IntegrationToggleEnvelope, 200, req, ctx.config);
+    if (!result.ok) {
+      return writerFailureResponse(requestedClient, result, ctx, {
+        desiredEnabled: parsed.enabled,
+        observedState: readIntegrationState(input).state,
+      });
+    }
+    return jsonResponse({
+      ...result,
+      desiredEnabled: parsed.enabled,
+    } satisfies IntegrationToggleEnvelope, 200, req, operationConfig);
```

The helper takes the committed snapshot explicitly so model export and the writer
cannot fall back to the stale request object:

```diff
 async function buildIntegrationWriteInput(
   clientId: IntegrationClientId,
   ctx: ManagementContext,
   store: IntegrationStateStore,
+  config: OcxConfig = ctx.config,
 ): Promise<IntegrationWriteInput> {
   return {
     clientId,
-    models: await loadExportModels(ctx.config),
-    config: ctx.config,
-    port: Number(ctx.url.port) || ctx.config.port,
+    models: await loadExportModels(config),
+    config,
+    port: Number(ctx.url.port) || config.port,
```

Ordering and failure behavior are fixed:

1. Invalid body: no intent and no file change.
2. Missing/invalid/conflicted config or lock refusal: no intent and no file change;
   return retryable `config_busy` only for real contention.
3. Intent committed, file mutation succeeds: return desired and observed state.
4. Intent committed, file mutation refuses/fails: never roll intent back. Return
   `desiredEnabled` plus freshly inspected `observedState` and the writer's recovery
   fields. Startup/ensure/status retries convergence.

Activation test: create a real temporary OpenCode config, disable OpenCode through
the real management route, then invoke `cmdOpencode`. The command must refuse before
proxy ensure/spawn, and the OpenCode file bytes must remain unchanged. This proves
the CLI guard is reachable from the state the real switch writes.

## A4 — per-client single-flight and the last-moment write check

Entry checks alone are racy. Codex awaits catalog work at
`src/codex/sync.ts:83-108` and then injects at `:110`; Grok awaits model discovery
at `src/grok/sync.ts:35-57` and then injects at `:61-65`. Either can start ON,
pause, persist OFF in another request, and write after OFF.

NEW `src/integrations/desired-state.ts` owns one operation boundary for all ten
ids. It replaces route-local Grok/apply and six-client flight maps. The boundary
has two layers:

- an in-process promise map joins an identical operation and refuses a competing
  direction;
- an OS-backed SQLite transaction in a per-client coordinator file prevents a
  CLI/startup process and the server's GUI/background process from writing the
  same client concurrently. Separate files preserve concurrency between different
  clients. Process exit releases the transaction; there is no stale lease row.

Every GUI route, CLI writer, startup sync, ensure sync, Desktop auto-apply, Grok
apply, Codex refresh, and WP5/WP6 native mutation reaches
`runClientIntegrationFlight(clientId, operationKey, operation)`. It enters exactly
once at the lowest shared owner of the irreversible write: a route that delegates
to `syncGrokConfig` or `syncModelsToCodex` does not acquire an outer flight and
deadlock the same client. Direct strip/restore routes acquire it themselves. No
surface keeps its own map.

The flight is necessary but not sufficient. Every irreversible write calls this
immediately before commit:

```ts
export function requirePersistedClientIntent(
  client: ClientIntegrationId,
  expectedEnabled: boolean,
): { ok: true; config: OcxConfig } | {
  ok: false;
  reason: "desired_state_changed" | "desired_state_unavailable";
};
```

The helper reads a fresh valid disk snapshot. Missing or invalid state fails
closed; it never falls back to a stale request object. Apply/inject/spawn requires
ON. Disable/removal requires OFF. The check is placed after async catalog/model
work and after compare-before-write, directly before each of these boundaries:

| Writer | Last-moment check |
|---|---|
| Codex catalog refresh | before catalog atomic replace |
| `injectCodexConfig` | after model resolution, before config/journal mutation |
| `injectGrokConfig` | after catalog resolution, before fenced-file write |
| six-client `commit` | after the existing byte recheck (`src/integrations/writer.ts:292-317,367-384`), before snapshot/file/record commit |
| Desktop profile/meta writers | before each selected-profile or metadata write |
| `cmdOpencode` | once at entry and again immediately before spawning with `OPENCODE_CONFIG_CONTENT` |

If the expected intent changed, the writer returns a typed skip/refusal and writes
nothing. A caller may retry under the new direction; it may not continue with the
old snapshot.

Deterministic race test: pause Codex and Grok model resolution on a controlled
promise, persist that client OFF through the real mutation helper, release the
promise, and assert catalog/inject spies remain zero. Repeat one file client with
its commit hook. The observable proof is unchanged target bytes, not only a skip
message.

## Automatic gates use the same owner

The entry gates remain useful because they avoid needless catalog work, but each
one enters the shared flight and still performs the last-moment check above.

### Codex

MODIFY `src/codex/sync.ts:49-55`:

```diff
-import { applyProxyEnv, loadConfig } from "../config";
+import { applyProxyEnv, clientIntegrationEnabled, loadConfig } from "../config";
@@
 ): Promise<CodexSyncResult> {
+  if (!clientIntegrationEnabled(loadConfig(), "codex")) {
+    return codexDesiredStateSkip();
+  }
+  return runClientIntegrationFlight("codex", "sync", async () => {
   const p = port ?? config.port ?? 10100;
```

Close the flight after the existing result return. `refreshCodexCatalogBestEffort`
at `src/server/management-api.ts:105-112` uses the same flight/reader rather than
a separate boolean check, so provider/model routes cannot bypass ordering.

### Grok

MODIFY `src/grok/sync.ts:29-35`:

```diff
+import { clientIntegrationEnabled, loadConfig } from "../config";
+import { runClientIntegrationFlight } from "../integrations/desired-state";
@@
 ): Promise<GrokInjectResult> {
+  if (!clientIntegrationEnabled(loadConfig(), "grok")) {
+    return { ok: true, changed: false, message: "Grok config sync skipped: desired state is OFF." };
+  }
+  return runClientIntegrationFlight("grok", "sync", async () => {
   let models: GrokInjectModel[];
```

Close the flight after injection. `/api/grok/apply` at
`src/server/management/agent-settings-routes.ts:639-657` deletes its local
`grokApplyFlight`; the shared owner covers start, both ensure branches, GUI apply,
toggle, and background work.

### Desktop and Claude consumers

Desktop auto-apply at `src/server/management/agent-settings-routes.ts:130-150`
requires both policies and enters the Desktop flight:

```diff
   async function autoApplyDesktopBestEffort(): Promise<void> {
     try {
+      if (!clientIntegrationEnabled(loadConfig(), "claude-desktop")) return;
       if (config.claudeCode?.desktopAutoApply === false) return;
```

`desktopAutoApply:false` is not migrated into Desktop OFF. Claude launcher,
agent injection, and system-env replace direct legacy reads with
`clientIntegrationEnabled(config, "claude-code")` as in the first draft. Claude
ingress and discovery retain their gates as specified in A1.

### OpenCode

MODIFY `src/cli/opencode.ts:531-533`:

```diff
 export async function cmdOpencode(args: string[]): Promise<number> {
   const config = loadConfig();
+  if (!clientIntegrationEnabled(config, "opencode")) {
+    console.error("OpenCode integration is disabled — turn it ON before using `ocx opencode`.");
+    return 1;
+  }
   const live = await ensureProxyForOpencode(config);
```

The command enters the OpenCode flight and repeats
`requirePersistedClientIntent("opencode", true)` immediately before spawn. OFF
must not start the proxy merely to refuse later.

## A5 — startup reconciliation: OFF means converge, not skip

Persist OFF, crash before the remover, restart: the first draft would skip future
apply and leave desired OFF / observed ON forever. Desired OFF is therefore a
converge instruction.

NEW `src/integrations/reconcile.ts` exposes:

```ts
export interface ClientReconcileResult {
  clientId: ClientIntegrationId;
  desiredEnabled: boolean;
  observedState: "absent" | "current" | "stale" | "conflict" | "unsafe";
  resolved: boolean;
  message: string;
}

export async function reconcileDisabledClientIntegrations(
  trigger: "startup" | "ensure" | "status",
  options?: { only?: readonly ClientIntegrationId[] },
): Promise<ClientReconcileResult[]>;
```

For every client whose fresh persisted intent is OFF:

1. Inspect observed state.
2. If absent, report resolved without writing.
3. If applied/current/stale, enter that client's shared flight, re-read OFF, and
   run the existing idempotent remover.
4. Re-inspect. Report `resolved:true` only when observed state is absent.
5. Preserve OFF and return an unresolved conflict for ownership, drift, unsafe
   metadata, history lock, or write failure. Never report desired OFF as observed
   OFF merely because the remover was attempted.

The six file clients use `disableIntegration`; Grok uses `stripGrokConfig`; Claude
Code has no external artifact and resolves from the persisted admission flag. WP5
registers Codex's `restoreNativeCodex` remover, then WP6 registers Desktop's
standard-mode remover. Registration is exhaustive over `ClientIntegrationId`, so
the final WP6 build cannot compile with either new native client omitted.

Invoke reconciliation at these real boundaries:

```diff
 // src/cli/index.ts:169-177
 async function handleStart(options: { block?: boolean } = {}) {
@@
   const requestedPort = parsePortOption();
+  await reconcileDisabledClientIntegrations("startup");
   if (!currentExternalCodexModelProvider()) reconcileJournal();
```

```diff
 // src/cli/index.ts:358-365
 async function handleEnsure() {
   if (!currentExternalCodexModelProvider()) reconcileJournal();
+  await reconcileDisabledClientIntegrations("ensure");
   const config = loadConfig();
```

Both collection and per-client GET routes call status reconciliation for the ids
being read before `readIntegrationState`/native status helpers run. Status returns
the unresolved result in `disableBlocked` or response diagnostics; it does not
hide a conflict and does not flip desired state back ON.

Crash-point tests use a hook immediately after `mutateClientIntegrationEnabled`
returns and before the remover begins. Terminate the simulated request there,
then invoke each of startup, ensure, and status reconciliation. For OpenCode and
Grok, assert the previously applied bytes are removed. For a drift/ownership
fixture, assert bytes remain, desired stays false, and the unresolved conflict is
reported. WP5 and WP6 add the same crash point for Codex and Desktop when their
removers land.

## Test plan

### `tests/client-integration-desired-state.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| Absent-config upgrade | Load a file with no map; all ten ids are ON. |
| Claude legacy fallback | New key absent + legacy false is OFF; new key wins once present. |
| Per-key malformed salvage | `{ codex: "false", grok: false }` yields Codex ON and Grok OFF without losing providers. |
| Two stale writers | Different client toggles both survive because each callback rebases on latest disk. |
| Simultaneous toggles | Different client keys both commit; neither whole-object snapshot wins. |
| Lock refusal and retry | Refusal changes neither disk nor live object; retry with that same object succeeds. |
| Claude field preservation | Mirroring changes only the new key and legacy `enabled`; every unrelated Claude field survives. |

### `tests/client-integration-auto-gates.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| Codex/Grok OFF at entry | Catalog and writer spies stay zero. |
| Codex/Grok OFF during fetch | Pause resolution, persist OFF, release; target bytes and writer counts remain unchanged. |
| Six-client last-moment check | Flip direction at the commit hook; no file/snapshot/record is written. |
| Desktop two-policy gate | Write occurs only when desired ON and `desktopAutoApply` permits it. |
| Real OpenCode activation | Disable through real PUT, invoke `cmdOpencode`; ensure/spawn stay zero and config bytes are unchanged. |
| Shared-flight coverage | GUI, CLI, startup, ensure, and background callers for one client cannot overlap; a different client can proceed. |

### Route and compatibility regressions

- `tests/management-integration-routes.test.ts`: all six PUTs persist intent before
  file work; post-persist refusal returns required desired plus observed state.
- `tests/native-grok-toggle.test.ts`: same ordering, lock refusal/retry, and no
  rollback of intent after ownership/catalog/write failure.
- `tests/native-claude-code-toggle.test.ts`: legacy OFF mirrors even when effective
  state already matches; a failed persist leaves the supplied config object
  untouched and the same object can retry.
- `tests/claude-management-api.test.ts`: the older route uses the same field-scoped
  mutation and preserves migration sentinels/other Claude fields.
- `tests/claude-messages-endpoint.test.ts`: legacy `enabled:false` still returns
  403 from Messages and count-tokens; Anthropic discovery remains empty.

### `tests/client-integration-reconciliation.test.ts` (NEW)

For each current remover, persist OFF and stop at the post-persist/pre-mutate hook.
Run startup, ensure, and status reconciliation independently and prove observed
state becomes absent. Fault fixtures prove drift/ownership/unsafe removals remain
unresolved and visible without changing desired OFF. WP5/WP6 append Codex/Desktop
cases sequentially when those removers exist.

## Verification

```bash
bun test tests/client-integration-desired-state.test.ts
bun test tests/client-integration-auto-gates.test.ts
bun test tests/client-integration-reconciliation.test.ts
bun test tests/management-integration-routes.test.ts tests/native-grok-toggle.test.ts
bun test tests/native-claude-code-toggle.test.ts tests/claude-management-api.test.ts
bun test tests/claude-messages-endpoint.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Live activation proof:

1. Record `/healthz` and PID.
2. Disable Grok and OpenCode through their real management routes. Confirm each
   status has `desiredEnabled:false` and honest observed state.
3. Run `ocx ensure`, restart the proxy, and read the target files. Neither managed
   contribution reappears; `/healthz` returns with the proxy still serving.
4. Disable OpenCode, run `ocx opencode`, and observe refusal before ensure/spawn.
5. With a legacy-only `claudeCode.enabled=false`, call Messages, count-tokens, and
   Anthropic discovery. Observe 403, 403, and an empty model list. Then call an
   invalid `/v1/responses` request and observe its normal validation response,
   never a client-disabled response.
6. Inject a post-persist crash for one file client, restart, and observe the
   remover converge it to absent. Repeat with drift and observe the unresolved
   conflict while desired remains OFF.

## Accept criteria

| Roadmap criterion | WP3 closure |
|---|---|
| C2 — disabled survives restart, ensure, and `/api/sync` | Every real switch writes intent; every automatic writer reads it; startup/ensure/status converge residual applied state. |
| C3 — absent config changes nothing on upgrade | Missing map/key is ON for all ten clients, except legacy Claude explicit OFF remains OFF. |
| C4 — disable never stops proxy or another client | No lifecycle operation is added; `/v1/responses` stays ungated; Claude's own ingress admission remains gated; every other client is governed only by its own key. |
| Coordination | `mutatePersistedConfig` prevents stale whole-object saves, the per-client flight orders every surface, and each writer re-reads intent immediately before commit. |
| Shared contract | Native union is `codex | claude | claude-desktop | grok`; status/success always include `desiredEnabled`; WP5 then WP6 consume it sequentially. |

WP3 is complete only when desired and observed state can disagree honestly and
the system keeps trying to reconcile that disagreement. A removed file with no
persisted intent is still the shipped Grok bug. A persisted OFF reported as
observed OFF while bytes remain is a new lie. A legacy Claude OFF that accepts
traffic again is a compatibility regression.
