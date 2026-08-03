# WP4 — Codex desired state and ownership-safe convergence

Research: `003_durable_desired_state.md`. Re-scope authority:
`006_audit_synthesis_r2.md`. This document replaces the failed ten-client
version of WP4.

The failure to prevent is concrete: a user persists Codex OFF, the process dies
before native restore finishes, and the next `ocx start` writes OpenCodex routing
back because `syncModelsToCodex` is unconditional (`src/cli/index.ts:318-320`,
`src/codex/sync.ts:49-110`). The first repair made that worse: startup
reconciliation called the native remover without checking service ownership, so
a start from a different `OPENCODEX_HOME` could strip Codex state used by the
installed service (`006_audit_synthesis_r2.md`, round 2 #2).

That incident decides the scope. The two phases that shipped cleanly each changed
one thing at one boundary (`010_modality_boundary.md`, `020_api_keys_row.md`). WP4
therefore changes desired state for **Codex only**. It does not establish a
cross-client contract.

## What exists, and what WP4 adds

Already present:

- `mutatePersistedConfig` clones and rebases a callback under the config mutation
  lock, then returns `committed | unchanged | unavailable`; callers do not need a
  second persistence mechanism (`src/config.ts:1825-1906`).
- `syncModelsToCodex` owns the normal catalog-plus-injection path
  (`src/codex/sync.ts:49-129`), while provider/model/combo routes bypass it through
  `refreshCodexCatalogBestEffort` (`src/server/management-api.ts:105-112`).
- `restoreNativeCodex` is the idempotent Codex remover
  (`src/codex/inject.ts:759-795`), and `assertNativeTeardownOwned` is the shipped
  foreign-home preflight (`src/integrations/native/ownership-preflight.ts:19-35`).
- crash-journal reconciliation already repairs an abandoned injection
  (`src/codex/journal.ts:148-162`).

WP4 adds one persisted Codex flag, one Codex write coordinator, last-moment
persisted-state checks for automatic apply writes, and OFF reconciliation at start
and ensure. WP5 adds the management route and GUI switch that call the writer;
WP4 does not define their response schema.

## IN / OUT

| Path | Change | Why it is in WP4 |
|---|---|---|
| `src/types.ts` | MODIFY | Adds a one-key `OcxClientIntegrationsConfig` and its optional `OcxConfig.clientIntegrations` home. |
| `src/config.ts` | MODIFY | Parses the Codex key, resolves absent as ON, re-reads persisted intent, and mutates only that field through the real `mutatePersistedConfig` signature. |
| `src/codex/desired-state.ts` | NEW | Owns the Codex-only process/OS write flight, last-moment authority checks, owned restore wrapper, and OFF reconciliation. |
| `src/codex/sync.ts` | MODIFY | Admits automatic Codex sync only while desired ON and passes a fresh-write authority through catalog and injection. |
| `src/codex/refresh.ts` | MODIFY | Carries the authority to the direct catalog/cache path used outside `syncModelsToCodex`. |
| `src/codex/catalog/sync.ts` | MODIFY | Re-reads desired ON after model gathering and immediately before catalog/cache replacement. |
| `src/codex/catalog/bundled.ts` | MODIFY | Prevents fallback catalog materialization before a fresh desired-ON check. |
| `src/codex/catalog/parsing.ts` | MODIFY | Calls the authority separately before each pristine-backup copy/write. |
| `src/codex/inject.ts` | MODIFY | Re-checks desired ON at the injection commit boundaries and makes the unchecked remover internal to the owned wrapper. |
| `src/server/management-api.ts` | MODIFY | Gives provider/model/combo refreshes their own Codex gate and routes `/api/stop` through the owned remover. |
| `src/server/management/config-routes.ts` | MODIFY | Makes `POST /api/sync` report an intentional desired-OFF skip instead of false success. |
| `src/cli/index.ts` | MODIFY | Reconciles OFF after journal repair, explains start/ensure skips, and routes every CLI/shutdown remover through the owned flight. |
| `src/cli/init.ts` | MODIFY | Uses the write flight without turning explicit bootstrap into an automatic desired-state gate. |
| `src/service.ts` | MODIFY | Routes service stop/uninstall removers through the same owned flight without changing desired state. |
| `tests/codex-desired-state.test.ts` | NEW | Pins schema defaulting, field-scoped persistence, auth-sentinel isolation, and unavailable/conflict behavior. |
| `tests/codex-desired-state-race.test.ts` | NEW | Pins in-flight OFF, crash-point convergence, single-flight, and foreign-home refusal. |
| `tests/codex-sync-api.test.ts` | MODIFY | Pins sync and `POST /api/sync` OFF semantics. |
| `tests/codex-inject-integration.test.ts` | MODIFY | Pins guarded commit boundaries and the owned native remover. |
| `tests/codex-journal.test.ts` | MODIFY | Proves journal repair still runs while desired Codex state is OFF. |
| `tests/service.test.ts`, `tests/uninstall.test.ts` | MODIFY | Proves owned teardown remains unconditional with respect to desired ON/OFF. |
| `tests/server-auth.test.ts` | MODIFY | Proves Codex OFF does not gate the shared `/v1/responses` transport. |

OUT, deliberately:

| Path / surface | Disposition |
|---|---|
| `src/server/claude-messages.ts`, `src/server/index.ts`, `src/cli/claude.ts`, `src/claude/agents-inject.ts`, `src/server/system-env.ts` | **Dropped from WP4.** Round 1 #1 established `claudeCode.enabled` as the shipped Claude Code kill switch. WP4 neither changes it nor routes it through a helper. |
| `src/integrations/state.ts`, `src/integrations/writer.ts`, `src/server/management/integration-routes.ts`, `src/cli/opencode.ts` | **Moved out.** The six file clients are `FOLLOWUP-FILECLIENT-01`; this removes the old gates, writer changes, mutating GET, and migration claims rejected by round 2 #4/#5. |
| `src/grok/**`, Grok routes | **Moved to WP6.** Grok will add its own key and prove its own callers after the Codex shape passes. |
| `src/claude/desktop-3p.ts`, Desktop routes | **Moved to WP7.** Desktop keeps its separate ownership/profile questions. |
| `src/server/management/native-integration-routes.ts`, `gui/` | **Moved to WP5.** WP5 owns the Codex route, GUI parser, and UI contract. WP4 does not define a `codex | claude | claude-desktop | grok` union or `desiredEnabled` response schema. |
| desired-state admission in `ocx init` | **Not added. INFERRED:** `ocx init` is a user-commanded setup operation, not one of the automatic re-apply paths named by this phase. Its direct injection still uses the Codex write flight so it cannot overlap another irreversible Codex write. |
| `/v1/responses` | Never gated. It is a shared transport used by clients other than native Codex. |
| releases, publishing, deploys, tags, repository starring | No delivery or identity action belongs in this phase. |

## The flag: one key in an extension-safe object

Use a map-shaped object with **one key today**, not a top-level `codexEnabled`
field and not the prior ten-key union. A top-level field would force WP6 and WP7
to invent unrelated names and helpers; a ten-key type would recreate the coupling
that failed two audits. A one-key object preserves the upgrade-safe extension
point while making WP4 incapable of claiming ownership over another client.

MODIFY `src/types.ts` immediately before `OcxConfig` (current
`src/types.ts:521-533`) and place the field beside `claudeCode`
(`src/types.ts:533-545`):

```diff
 export interface OcxApiKeyEntry {
   id: string;
   name: string;
   key: string;
   createdAt: string;
 }

+export interface OcxClientIntegrationsConfig {
+  /** Durable desired state for native Codex. Missing means ON. */
+  codex?: boolean;
+}

 export interface OcxConfig {
```

```diff
   /** Claude Code inbound + launcher settings. */
   claudeCode?: OcxClaudeCodeConfig;
+  /** Per-client durable intent. WP4 owns only `codex`; later phases extend one key at a time. */
+  clientIntegrations?: OcxClientIntegrationsConfig;
```

MODIFY `src/config.ts` after `apiKeyEntrySchema`
(`src/config.ts:909-918`). The nested schema stays `.passthrough()` so a binary
from WP4 does not erase a later WP6/WP7 key during a field-scoped mutation.

```diff
   name: z.string().catch(""),
   createdAt: z.string().catch(""),
 }).passthrough();

+const clientIntegrationsSchema = z.object({
+  codex: z.boolean().optional().catch(undefined),
+}).passthrough();

 const configSchema = z.object({
```

```diff
   googleAntigravityStaticCatalogVersion: z.literal(1).optional().catch(undefined),
+  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
   providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
```

Effective state is `config.clientIntegrations?.codex !== false`. Missing object,
missing key, and explicit `true` all mean ON. A malformed hand edit such as
`{ "codex": "false", "future-client": false }` degrades only `codex` to absent/ON
and preserves the unknown future key; it does not invalidate providers or create
another client's block.

## Field-scoped persistence and the auth sentinel

The real primitive is synchronous and callback-based
(`src/config.ts:1854-1856`):

```ts
export function mutatePersistedConfig<T>(
  mutate: (config: OcxConfig) => PersistedConfigMutation<T>,
): PersistedConfigMutationOutcome<T>;
```

Build the Codex writer directly on it after `websocketsEnabled`
(`src/config.ts:1909-1911`):

```diff
 export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
   return config.websockets === true;
 }

+export function codexDesiredEnabled(
+  config: Pick<OcxConfig, "clientIntegrations">,
+): boolean {
+  return config.clientIntegrations?.codex !== false;
+}
+
+export interface CodexDesiredMutationValue {
+  config: OcxConfig;
+  desiredEnabled: boolean;
+}
+
+export function mutateCodexDesiredEnabled(
+  enabled: boolean,
+): PersistedConfigMutationOutcome<CodexDesiredMutationValue> {
+  return mutatePersistedConfig(config => {
+    if (config.clientIntegrations?.codex === enabled) {
+      return { changed: false, value: { config, desiredEnabled: enabled } };
+    }
+    config.clientIntegrations = { ...config.clientIntegrations, codex: enabled };
+    return { changed: true, value: { config, desiredEnabled: enabled } };
+  });
+}
```

Only the callback-local clone is mutated. A future WP5 route must use
`outcome.value.config` after `committed | unchanged`; it must never patch the
long-lived management `config` before persistence succeeds. `missing`, `invalid`,
and `conflict` leave both disk and the supplied live object unchanged.

Round 2 #1 is **unreachable for this Codex-only shape**. The mutation above writes
only the sibling `clientIntegrations` object. It never reads, spreads, creates, or
assigns `config.claudeCode`. `runClaudeAuthModeMigration` returns immediately when
that block is absent (`src/claude/auth-mode-migration.ts:16-20`) and is invoked on
startup only afterward (`src/server/index.ts:290-294`). Therefore a Codex flag
write cannot create the pre-upgrade sentinel condition. The test still runs the
real migration after OFF and ON mutations and asserts: no `claudeCode` block,
`runClaudeAuthModeMigration(...) === false`, and no persisted `authMode` or
`authModeMigratedAt`.

## One Codex write flight, with a last-moment authority read

Entry checks do not close the race. `syncModelsToCodex` can pause in provider
model gathering (`src/codex/sync.ts:83-108`), while another process persists OFF,
then continue into injection at `src/codex/sync.ts:110`.

NEW `src/codex/desired-state.ts` owns one Codex coordinator:

```ts
export type CodexWriteDirection = "apply" | "remove";

export type PersistedCodexAuthority =
  | { ok: true; config: OcxConfig }
  | { ok: false; reason: "desired_state_changed" | "desired_state_unavailable" };

export interface CodexReconcileResult {
  trigger: "startup" | "ensure";
  desiredEnabled: boolean;
  observedState: "absent" | "applied" | "conflict" | "unavailable";
  resolved: boolean;
  reason?: "home_mismatch" | "history_locked" | "write_failed" | "codex_write_busy";
  message: string;
}

export function requirePersistedCodexIntent(
  expectedEnabled: boolean,
): PersistedCodexAuthority;

export async function runCodexWriteFlight<T>(
  direction: CodexWriteDirection,
  operation: () => Promise<T>,
): Promise<T>;

export function runCodexWriteFlightSync<T>(
  direction: CodexWriteDirection,
  operation: () => T,
): T;

export function restoreNativeCodexOwned(): { success: boolean; message: string };

export async function reconcileCodexDesiredState(
  trigger: "startup" | "ensure",
): Promise<CodexReconcileResult>;
```

**INFERRED design choice:** the coordinator has one in-process tail and one
OS-backed SQLite transaction at
`getCodexHome()/opencodex-write.sqlite` (`src/codex/paths.ts:32-35`). The lock is
keyed by the native target, not `OPENCODEX_HOME`: two OpenCodex homes can point at
the same `CODEX_HOME`, and they must not acquire different locks for the same
files. The config mutation lock is deliberately not reused: holding it across
model fetch would prevent OFF from being persisted, which is the race this phase
must handle. A second process waits with a bounded timeout; timeout returns
`codex_write_busy` and writes nothing. The sync form exists for
shutdown/`process.on("exit")`, where a Promise cannot be awaited.

`requirePersistedCodexIntent` uses `readConfigDiagnostics`
(`src/config.ts:1691-1708`), not a request's captured config. A missing or invalid
file is unavailable at a write boundary and fails closed; it is not reinterpreted
as an upgrade-time ON after an operation has already begun.

Every automatic apply path enters `runCodexWriteFlight("apply", ...)`, and the
authority is re-read after its last await and immediately before each commit
boundary. `InjectCodexOptions` and the catalog helpers receive a
`beforeWrite(boundary)` callback; they call it again for every separate file or DB
write rather than treating several writes as one group:

| Boundary | Current write | WP4 check |
|---|---|---|
| bundled fallback | `materializeBundledCodexCatalog` at `src/codex/catalog/bundled.ts:213-219` | pass the authority into `loadCatalogForSync`; re-read before fallback materialization |
| pristine backups | `copyFileSync` / `atomicWriteFile` at `src/codex/catalog/parsing.ts:428-444` | re-read separately inside `writePristineCatalogBackup` before each backup copy/write |
| catalog | `atomicWriteFile(catalogPath, ...)` at `src/codex/catalog/sync.ts:568` | `requirePersistedCodexIntent(true)` after `gatherRoutedModels` and directly before replace |
| models cache | `atomicWriteFile(activeCodexModelsCachePath(), ...)` at `src/codex/catalog/sync.ts:600-613` | re-read before cache replacement |
| injection journal | `writeJournal(...)` at `src/codex/inject.ts:521-527` | re-read before recording an apply transaction |
| config | first atomic write at `src/codex/inject.ts:593-596` | re-read immediately before `CODEX_CONFIG_PATH` replacement |
| profile | second atomic write at `src/codex/inject.ts:595-597` | re-read again immediately before `CODEX_PROFILE_PATH` replacement |
| journal injected marker | `markJournalInjectedState(...)` at `src/codex/inject.ts:597` | re-read again before advancing journal state |
| history mutation | `syncCodexHistoryProvider` / `migrateHistoryToOpenai` at `src/codex/inject.ts:598-603` | re-read before the DB mutation |
| native remove | `restoreNativeCodex` body at `src/codex/inject.ts:764-795` | ownership preflight first; startup reconciliation also re-reads OFF immediately before remove |

`src/codex/inject.ts` renames the raw remover to
`restoreNativeCodexUnchecked`; only `src/codex/desired-state.ts` may import it.
All production callers import `restoreNativeCodexOwned` instead. A source-shape
test rejects any other import of the unchecked symbol. This makes the round 2 #2
preflight an owned boundary rather than a convention each caller can forget.

Stop, uninstall, and explicit restore use the owned remover but **do not require
desired OFF** and never rewrite the flag. They are safety teardown, not user-intent
mutation (`src/service.ts:2587-2594`). Startup/ensure reconciliation uses the same
remover with the additional fresh-OFF check.

`src/service.ts` must not statically import the new wrapper. The wrapper imports
`assertNativeTeardownOwned`, whose current implementation imports `service.ts`
(`src/integrations/native/ownership-preflight.ts:14-17`); a static reverse import
would create `service -> desired-state -> ownership-preflight -> service`. Remove
the current static raw-remover import at `src/service.ts:15` and dynamically import
`restoreNativeCodexOwned` inside the already-async stop/uninstall branches before
calling it. **INFERRED:** this is the smallest way to keep the shipped preflight as
the authority without broadening WP4 into a service-ownership module extraction.

## Automatic Codex gates

### Normal sync path

MODIFY `src/codex/sync.ts:49-55` so the entry gate avoids unnecessary fetches and
the write flight covers catalog plus injection as one Codex operation:

```diff
 export async function syncModelsToCodex(
   port?: number,
   config: OcxConfig = loadConfig(),
   log: Pick<Console, "log" | "error"> | null = console,
   deps: CodexSyncDeps = defaultDeps,
 ): Promise<CodexSyncResult> {
+  if (!codexDesiredEnabled(config)) return codexDesiredOffSyncResult(log);
+  return runCodexWriteFlight("apply", async () => {
   const p = port ?? config.port ?? 10100;
```

Close the flight after the existing return at `src/codex/sync.ts:114-129`.
`CodexSyncResult` adds optional `skippedReason: "desired-off" |
"desired-state-unavailable" | "codex-write-busy"`. Desired OFF is an intentional
no-write result, not a claim that catalog/injection completed.

`ocx start` and both `ocx ensure` branches remain callers at
`src/cli/index.ts:318-320,358-411`; they inspect `skippedReason` and print
`Codex auto-apply skipped: desired state is OFF.` once. They do not stop the
proxy, alter its port, or skip another client's setup.

`POST /api/sync` at `src/server/management/config-routes.ts:261-268` returns a
409 `codex_desired_off` envelope when the sync result says desired OFF. It must
not return the current 200-shaped success for an operation that intentionally
wrote nothing. **INFERRED:** 409 distinguishes a valid request blocked by current
desired state from a server fault; 200 would preserve the false-green finding and
500 would misclassify an intentional policy decision. Other sync failures keep
their existing 500 behavior.

### Provider/model/combo refresh bypass

The management helper currently calls `refreshCodexModelCatalog(config)` directly
(`src/server/management-api.ts:105-112`), so a gate only in
`syncModelsToCodex` is insufficient. Replace it with a separately gated entry:

```diff
   async function refreshCodexCatalogBestEffort(): Promise<void> {
-    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
     try {
-      const { refreshCodexModelCatalog } = await import("../codex/refresh");
-      await refreshCodexModelCatalog(config);
+      const { refreshCodexCatalogIfDesired } = await import("../codex/sync");
+      await refreshCodexCatalogIfDesired(async freshConfig => {
+        if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
+        const { refreshCodexModelCatalog } = await import("../codex/refresh");
+        await refreshCodexModelCatalog(freshConfig);
+      });
     } catch {
       /* catalog absent */
     }
   }
```

`refreshCodexCatalogIfDesired` loads persisted state, enters the same Codex write
flight, and passes the same last-moment authority into `refreshCodexModelCatalog`.
The injected test dependency is inside that gate, not an early-return bypass.
Provider/model/combo routes therefore cannot bypass OFF, but no Claude, Grok,
Desktop, or file-client reader changes.

## Startup reconciliation: OFF means remove again

The order in `handleStart` matters. Journal repair remains unconditional and runs
first; desired OFF convergence runs second; automatic sync runs later and observes
OFF:

```diff
 async function handleStart(options: { block?: boolean } = {}) {
@@
   const requestedPort = parsePortOption();
   if (!currentExternalCodexModelProvider()) reconcileJournal();
+  await reconcileCodexDesiredState("startup");
   const existingPid = readPid();
```

Apply the same reconciliation after journal repair in `handleEnsure`
(`src/cli/index.ts:358-365`). Reconciliation does exactly this:

1. Fresh-read desired state. ON or unavailable performs no removal.
2. For OFF, enter the Codex remove flight and fresh-read OFF again.
3. Immediately before removal, call `assertNativeTeardownOwned` inside the flight.
4. If ownership is foreign, return unresolved `home_mismatch`; preserve OFF and
   every Codex byte. Otherwise call `restoreNativeCodexUnchecked`.
5. Inspect the native artifacts again. Report resolved only when OpenCodex routing,
   profile, and proxy-routed catalog residue are absent. A history lock remains an
   explained unresolved result; desired OFF is not rolled back.

The crash point is after `mutateCodexDesiredEnabled(false)` commits and before the
remover starts. Restarting from that fixture must execute steps 1-5 again. A GET
route is not used as a repair trigger; round 2 #5's mutating-GET design is dropped.

## Do not gate these paths

- `reconcileJournal` remains unconditional (`src/codex/journal.ts:148-162`). It
  repairs an abandoned transaction before desired-state convergence decides the
  final direction.
- ownership and drift inspection always run. Desired OFF never bypasses
  `assertNativeTeardownOwned`.
- stop, uninstall, shutdown, and explicit native restore always remove state they
  own, regardless of desired ON, and never persist OFF
  (`src/service.ts:2587-2594`).
- `/v1/responses` remains admitted. Codex OFF means “stop automatically writing
  native Codex configuration,” not “stop serving Responses.”
- no Claude Code, Grok, Desktop, or file-client path reads the Codex key.

## Test plan

### `tests/codex-desired-state.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| Upgrade default | Load config with no `clientIntegrations`; Codex is ON and no bytes are rewritten. |
| One-key parser | `codex:false` loads OFF; malformed `codex:"false"` degrades to ON while a future unknown key survives a field mutation. |
| Field-scoped commit | Mutate OFF from a stale live object; unrelated providers, API keys, and unknown fields survive. The live object is unchanged. |
| Lock/conflict refusal | Hold the real config mutation lock; mutation changes neither disk nor live object. Retry succeeds after release. |
| Auth sentinel unreachable | Start with no `claudeCode`, mutate Codex OFF then ON, reload, run `runClaudeAuthModeMigration`; it returns false and never creates `authMode` or `authModeMigratedAt`. |

### `tests/codex-desired-state-race.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| OFF during model fetch | Pause `gatherRoutedModels`, persist OFF through the real writer, release; catalog, cache, journal, config, profile, and history writer counts remain zero. |
| Direct refresh bypass | Invoke a real provider/model route while OFF; `refreshCodexCatalogBestEffort` performs no catalog/cache write. |
| Single-flight | Hold one apply at the fetch seam, start a second-process refresh and a remove; no two Codex commit sections overlap, and the final operation re-reads the newest intent. |
| Crash after persist | Commit OFF, abort before remove, run startup and ensure independently; each converges a seeded applied Codex fixture to native state. |
| Foreign home | Seed install state for home A, run OFF startup reconciliation from home B; `assertNativeTeardownOwned` returns `home_mismatch`, all Codex bytes remain exact, and desired OFF remains persisted. |
| Stop does not change intent | With desired ON, run owned stop/uninstall teardown; artifacts are removed and the flag remains ON. |

### Existing regressions

- `tests/codex-sync-api.test.ts`: OFF at entry avoids fetch/inject; OFF during
  fetch returns the typed skip; `POST /api/sync` is 409 `codex_desired_off`, not
  200 and not 500.
- `tests/codex-inject-integration.test.ts`: each injected write authority seam is
  reachable independently (journal, config, profile, journal mark, history); only
  `src/codex/desired-state.ts` imports the unchecked remover.
- `tests/codex-journal.test.ts`: seed a dead-PID journal while desired OFF; journal
  reconciliation runs, then OFF convergence removes residual routing.
- `tests/service.test.ts` and `tests/uninstall.test.ts`: every production native
  remover passes through `assertNativeTeardownOwned`; foreign-home teardown writes
  nothing; owned teardown never changes desired state.
- `tests/server-auth.test.ts`: add a live-server case with
  `clientIntegrations.codex=false`; `POST /v1/responses` reaches the same normal
  validation/routing response as ON, never a client-disabled response.

## Verification

All tests use temporary `OPENCODEX_HOME`, `CODEX_HOME`, config, catalog, profile,
journal, history, and service-install-state fixtures. Do not point any command at
the user's live proxy on port 10100.

```bash
bun test tests/codex-desired-state.test.ts
bun test tests/codex-desired-state-race.test.ts
bun test tests/codex-sync-api.test.ts tests/codex-inject-integration.test.ts
bun test tests/codex-journal.test.ts tests/service.test.ts tests/uninstall.test.ts tests/server-auth.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Live proof is the subprocess case in `tests/codex-desired-state-race.test.ts`, not
the installed `ocx`: it launches the repository CLI with isolated homes and an
ephemeral non-10100 port and records PID and `/healthz`. First it commits OFF and
converges while the process stays alive. In a separate run it kills at the
post-persist/pre-remove seam and relaunches from the same isolated home. It proves:

1. `/healthz` returns from the same PID after the live OFF mutation; disabling
   native Codex did not stop or replace the proxy.
2. native Codex routing/profile/catalog residue converges to absent after restart.
3. an invalid `/v1/responses` request reaches its normal validation response, not
   a desired-state gate.
4. repeating from a foreign `OPENCODEX_HOME` leaves every Codex artifact byte-exact
   and reports `home_mismatch`.

The test must print the isolated roots, chosen port, before/after hashes, and
reconciliation result so the C-phase evidence proves the live path rather than
only a mocked helper. It must tear down only its recorded subprocess and temp
directory.

## Accept criteria

| Roadmap criterion | WP4 closure |
|---|---|
| C2 — Codex stays disabled across restart, ensure, and `/api/sync` | OFF is persisted through `mutatePersistedConfig`; startup/ensure converge residual apply state; sync and direct catalog refresh re-read OFF before writing; `/api/sync` reports the skip honestly. |
| C3 — absent config changes nothing on upgrade | Missing object/key remains ON. The one-key parser and no-write upgrade test prove existing installs keep current behavior. |
| C4 — disabling Codex never stops proxy or closes `/v1/responses` | No lifecycle or transport gate is added. The isolated live proof keeps `/healthz` and the Responses route reachable while native Codex state is removed. |
| C7 — foreign-home startup touches nothing | Every production remover runs `assertNativeTeardownOwned` first; the foreign-home crash-recovery fixture proves byte-exact refusal with desired OFF preserved. |

WP4 is complete only when an operation that began ON can resume after OFF and
still perform zero Codex writes, and when a restart can finish an interrupted OFF
without touching a foreign service's state. A boolean without those two proofs is
the failed first draft in a smaller file.
