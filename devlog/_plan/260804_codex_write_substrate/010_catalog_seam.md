# WP9 — split Codex catalog gather from commit

Research: `001_catalog_seam.md`. Read it first; this doc is the diff.

The incident is r2 #1: the OFF design needed provider discovery outside a
per-`CODEX_HOME` lock and native writes inside it, but management exposes one
`Promise<void>` callback that gathers and writes before resolving
(`../260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:17-24`,
`src/server/management/context.ts:9-18`). Today `refreshCodexModelCatalog` awaits
the mixed `syncCatalogModels`, checks the file that function may just have
written, and then performs a second cache write (`src/codex/refresh.ts:40-52`,
`src/codex/catalog/sync.ts:507-569,600-616`). This phase adds an opaque,
point-in-time candidate, a pure gather, a fixed synchronous commit, a revision
check, and typed dispositions. It does not add the native write lock; WP11 owns
that. Until WP11, the existing orchestrator calls gather and then commit directly,
so the split is independently useful and the revision guard is exercised, without
pretending a lock already exists.

## IN / OUT

IN — production:

- `src/codex/refresh.ts` (MODIFY) — canonical candidate, revisions, gather/commit
  exports, outcome union, and the compatibility orchestrator.
- `src/codex/catalog.ts` (MODIFY) — re-export the prepared catalog contract from
  the existing facade; do not create a second catalog entry point.
- `src/codex/catalog/sync.ts` (MODIFY) — turn assembly into a write-free prepared
  payload and expose the fixed synchronous writer.
- `src/codex/catalog/bundled.ts` (MODIFY) — replace the materializing sync fallback
  with in-memory catalog bytes for the candidate.
- `src/codex/catalog/parsing.ts` (MODIFY) — prepare create-once pristine-backup
  bytes without writing; retain restore's existing writer path.
- `src/codex/catalog/provider-fetch.ts` (MODIFY) — return typed degradation notices
  and distinguish token resolution from provider-network failure.
- `src/codex/sync.ts` (MODIFY) — consume typed refresh outcomes and preserve the
  existing ordinary-failure injection fallback.
- `src/server/management/context.ts` (MODIFY) — replace the void callback with the
  paired candidate seam and typed best-effort result.
- `src/server/management-api.ts` (MODIFY) — orchestrate the injected or production
  pair, never swallow the disposition.
- `src/server/management/provider-routes.ts` (MODIFY) — six persisted mutations
  attach `catalogRefresh`.
- `src/server/management/model-routes.ts` (MODIFY) — six persisted mutations attach
  `catalogRefresh`.
- `src/server/management/combo-routes.ts` (MODIFY) — two persisted mutations attach
  `catalogRefresh` without suppressing Claude follow-up work.
- `src/server/management/agent-settings-routes.ts` (MODIFY) — two persisted
  mutations attach `catalogRefresh` without suppressing Claude/Desktop follow-up
  work.
- `src/server/management/config-routes.ts` (MODIFY) — explicit `/api/sync` maps
  typed authorization/contention/disk results instead of flattening every failure
  to 500.
- `structure/03_catalog-and-subagents.md` (MODIFY) — source-of-truth statement for
  the candidate/revision contract.
- `structure/05_gui-and-management-api.md` (MODIFY) — source-of-truth statement for
  best-effort mutation responses versus explicit sync.
- `docs-site/src/content/docs/reference/management-api.md` (MODIFY), plus the
  matching `ja`, `ko`, `ru`, and `zh-cn` files (MODIFY) — document the additive
  `catalogRefresh` field and explicit-sync status mapping.

IN — tests:

- `tests/codex-refresh.test.ts` (MODIFY) — pure gather, bounded commit, one-shot,
  stale config/base revisions, and partial write receipts.
- `tests/codex-sync-api.test.ts` (MODIFY) — typed fallback and no-injection cases.
- `tests/codex-models-cache-invalidate.test.ts` (MODIFY) — receipt-driven app-server
  invalidation behavior.
- `tests/injection-model-api.test.ts` (MODIFY) — immutable config snapshot rather
  than forwarding a mutable config reference.
- `tests/model-visibility-management-api.test.ts` (MODIFY),
  `tests/management-provider-validation.test.ts` (MODIFY),
  `tests/combo-management-api.test.ts` (MODIFY), `tests/combos.test.ts` (MODIFY),
  and `tests/codex-v2-gate.test.ts` (MODIFY) — paired seam and response disposition.
- `tests/management-integration-routes.test.ts` (MODIFY),
  `tests/management-client-config-route.test.ts` (MODIFY),
  `tests/responses-shadow-intercept.test.ts` (MODIFY),
  `tests/server-combo-failover-e2e.test.ts` (MODIFY), and
  `tests/catalog-input-modality-enum.test.ts` (MODIFY) — fixture type migration;
  no new behavior in routes that do not refresh.

OUT:

- `src/integrations/native/**`, `src/service.ts`, and a native write lock — WP11
  creates the lock and wraps `commitCodexCatalogCandidate`; WP9 must compile and
  behave correctly without it.
- Desired-state OFF reads and ownership admission — WP12 owns those authorities.
  The outcome union reserves `desired_off` and the orchestrator handles it, but
  WP9 does not invent a flag or emit that result.
- `gui/**` — responses are additive and the current dashboard does not need a new
  visual state in this substrate phase.
- `src/codex/history-provider.ts` — WP10 isolates history separately.
- `syncCodexModelsCacheFromCatalog` — retain the explicit raw-copy utility at
  `src/codex/refresh.ts:29-32`; it is not the active expired-wrapper commit.
- Transactional rollback — catalog and cache are separate atomic replacements;
  a receipt reports partial progress instead of claiming all-or-nothing behavior
  (`src/config.ts:178-230`, `src/codex/catalog/sync.ts:568,601-613`).

## The candidate and the two operations

MODIFY `src/codex/refresh.ts`. The public type is structurally opaque because its
brand symbol is module-private; the payload lives in a `WeakMap`, so it cannot be
JSON-serialized, reconstructed by a caller, or inspected for credentials. The
state holds strings, paths, revisions, notices, and result metadata only — no
mutable `OcxConfig`, file handle, callback, or promise.

```ts
const codexCatalogCandidateBrand: unique symbol = Symbol("CodexCatalogCandidate");

export interface CodexCatalogCandidate {
  readonly [codexCatalogCandidateBrand]: true;
}

interface CodexCatalogCandidateState {
  readonly prepared: PreparedCodexCatalogCommit;
  readonly revision: CodexCatalogRevision;
  readonly result: Omit<CodexCatalogRefreshResult, "catalogWritten" | "cacheSynced">;
  readonly notices: readonly CatalogGatherNotice[];
  consumed: boolean;
}

const candidateStates = new WeakMap<CodexCatalogCandidate, CodexCatalogCandidateState>();

/**
 * Discover providers and load every source needed to assemble the exact catalog,
 * backup, and expired-cache bytes that a later commit may write.
 *
 * WHY: provider auth, network I/O, bundled `codex debug models --bundled`, JSON
 * parsing, merging, and serialization are unbounded relative to a native-write
 * critical section. This operation therefore performs no mkdir/copy/write/rename
 * and returns an opaque point-in-time candidate instead of exposing writable
 * payloads to callers.
 */
export async function gatherCodexCatalogCandidate(
  config: OcxConfig,
): Promise<CodexCatalogCandidate>;

/**
 * Revalidate and consume one gathered candidate, then perform only its prepared
 * create-once backup writes, catalog replacement, and expired-cache replacement.
 *
 * WHY: r2 #1 can be fixed only if the eventual lock owner can call a synchronous,
 * fixed-write function. Rechecking config and base-catalog revisions here prevents
 * a candidate assembled from obsolete state from overwriting a newer catalog.
 * No provider call, auth resolution, subprocess, parse, merge, serialization, or
 * await is permitted below this boundary.
 */
export function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
): CodexCatalogCommitResult;
```

`gatherCodexCatalogCandidate` calls a write-free `prepareCatalogSync(config)` in
`src/codex/catalog/sync.ts`. That helper returns final catalog bytes, expired-cache
wrapper bytes, optional pristine-backup path/byte pairs, exact target paths,
`added`, `comboOmissions`, and notices.
The gather then freezes a tiny branded handle and stores the internal state in the
`WeakMap`. `commitCodexCatalogCandidate` rejects a missing/consumed handle as
`stale_candidate`, marks a valid handle consumed before the first write, compares
revisions, and invokes `writePreparedCatalogCommit` only on an exact match.

Mark-before-write is deliberate. Retrying a partially written candidate would
replay old bytes after a later convergence. A disk failure returns its receipt;
the caller regathers instead of recommitting the consumed handle.

## C2 — the revision guard

The guard uses content revisions, not mtimes. An mtime can change without content,
can be restored, and has platform-dependent resolution; the merge at
`src/codex/catalog/sync.ts:520-565` depends on exact catalog bytes. **INFERRED:**
SHA-256 of canonical config input and exact base-catalog bytes is the smallest
evidence that detects every input change relevant to this candidate while avoiding
raw credential retention.

```ts
type ContentRevision =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly sha256: string };

interface CodexCatalogRevision {
  readonly configSha256: string;
  readonly baseCatalog: ContentRevision;
  readonly codexHome: string;
  readonly catalogPath: string;
  readonly cachePath: string;
}
```

Gather captures exactly these values:

1. `configSha256`: SHA-256 of stable-key JSON containing the complete `providers`
   object (including auth mode and credential/env references), `disabledModels`,
   `customModels`, `combos`, `subagentModels`, `multiAgentMode`,
   `providerContextCaps`, `contextCapValue`, `modelCacheTtlMs`, `websockets`, and the
   fresh `isMultiAgentV2Enabled()` value. Those are the inputs consumed by provider
   gathering and final assembly (`src/codex/catalog/provider-fetch.ts:98-142,670-719,785-814`,
   `src/codex/catalog/sync.ts:533-565`). The digest includes credential values so a
   key rotation invalidates stale discovery, but the candidate never retains or
   returns those values.
2. `baseCatalog`: `absent`, or SHA-256 of the exact bytes read from `catalogPath`
   before parsing. This is the merge source whose routed and user-native rows are
   preserved (`src/codex/catalog/sync.ts:517-523,430-468`).
3. `codexHome`: `realpathSync.native(resolveCodexHomeDir())`, plus the resolved
   `catalogPath` and `activeCodexModelsCachePath()`. This prevents an environment or
   config-path change from redirecting prepared bytes to another home
   (`structure/02_config-and-codex-home.md:3-21`,
   `src/codex/catalog/parsing.ts:73,167`).

At commit, synchronously and before any mkdir/write, recompute:

- the config digest from `readConfigDiagnostics().config` plus a fresh feature-flag
  read;
- the canonical home and both target paths; and
- the exact current catalog content digest/absence marker.

Every field must equal the candidate revision. Any mismatch returns
`{ status: "skipped", reason: "stale_candidate", retryable: true }`, consumes the
candidate, and produces an all-false write receipt. No backup directory, backup,
catalog, or cache is created. A newly appearing backup does not make the candidate
stale: backups are create-once; the commit rechecks each optional backup path and
skips that one write if another actor already created it
(`src/codex/catalog/parsing.ts:428-444`).

Provider inventory changing upstream after gather is not a revision mismatch. The
candidate represents one completed discovery. A subsequent refresh may supersede
it; wall-clock age is not used (`src/codex/catalog/provider-fetch.ts:481-510,670-717`).

Without WP11 there is no cross-process critical section around compare-and-write.
WP9 still makes the operation correct for every revision change completed before
commit begins and for all same-process interleavings because commit contains no
`await`. **INFERRED:** an external process can still replace the catalog after the
comparison and before rename; WP11 closes that remaining TOCTOU by placing this
unchanged synchronous function under the shared per-home lock. WP9 must not claim
cross-process linearizability before that phase.

## Typed outcomes

MODIFY `src/codex/refresh.ts` with one closed public outcome and a public,
credential-free management projection:

```ts
export type CatalogGatherNotice = {
  kind: "provider_degraded";
  reason: "provider_network" | "provider_auth";
  fallback: "stale" | "configured";
};

export interface CatalogWriteReceipt {
  catalogBackup: boolean;
  legacyBackup: boolean;
  catalog: boolean;
  cache: boolean;
}

export type CodexCatalogCommitResult =
  | { status: "committed"; result: CodexCatalogRefreshResult; writes: CatalogWriteReceipt }
  | { status: "skipped"; reason: "stale_candidate"; retryable: true; writes: CatalogWriteReceipt }
  | { status: "failed"; reason: "disk"; phase: "commit"; retryable: true; writes: CatalogWriteReceipt };

export type CodexCatalogSkipReason =
  | "catalog_unavailable"
  | "desired_off"
  | "gather_busy"
  | "lock_busy"
  | "stale_candidate";

export type CodexCatalogRefreshOutcome =
  | { status: "committed"; result: CodexCatalogRefreshResult; notices: readonly CatalogGatherNotice[]; writes: CatalogWriteReceipt }
  | { status: "skipped"; reason: CodexCatalogSkipReason; retryable: boolean; writes: CatalogWriteReceipt }
  | { status: "failed"; reason: "provider_network" | "provider_auth" | "disk"; phase: "gather" | "commit"; retryable: boolean; writes: CatalogWriteReceipt };

export type CatalogRefreshDisposition =
  | { status: "committed"; degraded: boolean }
  | { status: "skipped"; reason: CodexCatalogSkipReason; retryable: boolean }
  | { status: "failed"; reason: "provider_network" | "provider_auth" | "disk"; retryable: boolean; partialWrite: boolean };
```

Do not expose provider names, URLs, token text, catalog paths, or digests through
`CatalogRefreshDisposition`. `committed` plus `degraded:true` is how a stale/static
provider fallback remains visible without turning the primary route into a failure.
`partialWrite` is `true` when any receipt bit is true.

`refreshCodexModelCatalog(config, deps)` becomes the direct gather-then-commit
orchestrator for WP9. It maps `CatalogGatherBusyError` to `skipped/gather_busy`,
typed token-resolution failure to `failed/provider_auth`, escaped provider fetch
failure to `failed/provider_network`, no source to `skipped/catalog_unavailable`,
and commit errors to their returned result. It does not emit `desired_off` or
`lock_busy`; WP11/WP12 add those admission results without changing callers.

### Every management caller

All 16 rows are best-effort by design. For every variant they retain their current
2xx/201 primary status, attach `catalogRefresh`, and never roll back the config
mutation that already landed. `committed` reports `degraded:false|true`; OFF,
gather/lock contention, and stale candidates report `skipped` with reason and
retryability; auth/network/disk report `failed`. The route-specific continuation is
the only difference.

| Exact outcome | `catalogRefresh` projection on every row below |
|---|---|
| committed, no notices | `{ status: "committed", degraded: false }` |
| committed with provider network/auth fallback | `{ status: "committed", degraded: true }` |
| `desired_off` | `{ status: "skipped", reason: "desired_off", retryable: false }` |
| `gather_busy` | `{ status: "skipped", reason: "gather_busy", retryable: true }` |
| `lock_busy` | `{ status: "skipped", reason: "lock_busy", retryable: true }` |
| `stale_candidate` | `{ status: "skipped", reason: "stale_candidate", retryable: true }` |
| `catalog_unavailable` | `{ status: "skipped", reason: "catalog_unavailable", retryable: false }` |
| `provider_auth` | `{ status: "failed", reason: "provider_auth", retryable: false, partialWrite: false }` |
| `provider_network` | `{ status: "failed", reason: "provider_network", retryable: true, partialWrite: false }` |
| `disk` | `{ status: "failed", reason: "disk", retryable: true, partialWrite: <receipt-derived> }` |

| # | Caller and current line | Best-effort | Committed / degraded | OFF / gather busy / lock busy / stale | Auth / network / disk |
|---|---|---|---|---|---|
| P1 | provider add/overwrite, `src/server/management/provider-routes.ts:147-148` | YES | Return current 200 plus disposition. | Same 200; provider remains saved. | Same 200; no rollback. |
| P2 | ordinary provider edit/toggle, `src/server/management/provider-routes.ts:338-344` | YES | Return current 200 plus disposition. | Same 200; edited provider remains saved. | Same 200; no rollback. |
| P3 | provider delete, `src/server/management/provider-routes.ts:479-488` | YES | Return current 200 plus disposition. | Same 200; warn stale native rows through disposition. | Same 200; no rollback. |
| P4 | global context-cap value, `src/server/management/provider-routes.ts:503-513` | YES | `respond` includes disposition. | Same 200 and cap body. | Same 200 and cap body. |
| P5 | all context-cap toggles, `src/server/management/provider-routes.ts:516-528` | YES | `respond` includes disposition. | Same 200 and cap body. | Same 200 and cap body. |
| P6 | one provider context cap, `src/server/management/provider-routes.ts:531-547` | YES | `respond` includes disposition. | Same 200 and cap body. | Same 200 and cap body. |
| M1 | disabled models, `src/server/management/model-routes.ts:208-215` | YES | Return current 200 plus disposition. | Same 200; blocklist remains saved. | Same 200; no rollback. |
| M2 | model visibility, `src/server/management/model-routes.ts:221-314` | YES | Return current 200 plus disposition. | Same 200; visibility intent remains saved. | Same 200; no rollback. |
| M3 | custom model create, `src/server/management/model-routes.ts:321-353` | YES | Preserve 201; append disposition. | Preserve 201. | Preserve 201. |
| M4 | custom model edit, `src/server/management/model-routes.ts:356-391` | YES | Return current 200 plus disposition. | Same 200. | Same 200. |
| M5 | custom model delete, `src/server/management/model-routes.ts:394-405` | YES | Return current 200 plus disposition. | Same 200; possible stale row is explicit. | Same 200. |
| M6 | selected models, `src/server/management/model-routes.ts:426-441` | YES | Return current 200 plus disposition. | Same 200; allowlist remains saved. | Same 200. |
| C1 | combo create/update/rename, `src/server/management/combo-routes.ts:190-200` | YES | Return current 200 plus disposition. | Same 200; still run Claude sync when `shouldSyncClaudeAgentDefs`. | Same 200; still run Claude sync. |
| C2 | combo delete, `src/server/management/combo-routes.ts:203-217` | YES | Return current 200 plus disposition. | Same 200. | Same 200. |
| A1 | v2/settings write, `src/server/management/agent-settings-routes.ts:224-294` | YES | Return current 200 plus disposition and existing warnings. | Same 200; feature/config writes remain authoritative. | Same 200; no rollback. |
| A2 | subagent model write, `src/server/management/agent-settings-routes.ts:518-528` | YES | Return current 200 plus disposition. | Same 200; still run Claude and Desktop follow-ups. | Same 200; still run both follow-ups. |

Explicit sync is not in that table. `syncModelsToCodex` keeps injection fallback for
`catalog_unavailable`, provider degradation, provider auth/network failure, and disk
failure, matching the current catch-and-continue contract at
`src/codex/sync.ts:83-110` and `tests/codex-sync-api.test.ts:148-166`. It returns
before `injectCodexConfig` for `desired_off`, `lock_busy`, or `stale_candidate`:
those are authorization/serialization refusals, not missing catalog data. Gather
busy is retryable and also returns before injection so an explicit sync cannot
claim fresh native state while another revision is being assembled. `/api/sync`
maps `desired_off` and `stale_candidate` to 409, `gather_busy`/`lock_busy` to 503
with `Retry-After: 1`, and non-fallback disk failure to 500
(`src/server/management/config-routes.ts:261-268`).

## Diff

### Catalog preparation and fixed writes

MODIFY `src/codex/catalog/bundled.ts` at current lines 225-234. The fallback remains
in memory; it does not materialize a source while loading:

```diff
 export function loadCatalogForSync(path: string): RawCatalog | null {
@@
   return readCatalog(catalogBackupPathFor(path))
     ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
     ?? readCatalog(activeCodexModelsCachePath())
-    ?? materializeBundledCodexCatalog(path)
     ?? catalog;
 }
```

Retain `materializeBundledCodexCatalog` for its existing public callers
(`src/codex/catalog.ts:6`); only catalog gather stops calling it.

MODIFY `src/codex/catalog/parsing.ts` around current lines 428-444. Extract a pure
backup planner beside the existing restore-facing writer:

```diff
+export interface PreparedCatalogBackup {
+  path: string;
+  bytes: string;
+  kind: "catalog" | "legacy";
+}
+
+export function prepareCatalogBackups(
+  catalogPath: string,
+  catalog: RawCatalog,
+  onDiskBytes: string | null,
+): PreparedCatalogBackup[] {
+  const source = onDiskBytes === null ? null : parseCatalogJson(onDiskBytes);
+  const pristineBytes = source && !catalogHasRoutedEntries(source)
+    ? onDiskBytes
+    : !catalogHasRoutedEntries(catalog)
+      ? JSON.stringify(catalog, null, 2) + "\n"
+      : null;
+  if (pristineBytes === null) return [];
+  return [
+    { path: catalogBackupPathFor(catalogPath), bytes: pristineBytes, kind: "catalog" },
+    ...(isDefaultCatalogPath(catalogPath)
+      ? [{ path: legacyCatalogBackupPath(), bytes: pristineBytes, kind: "legacy" as const }]
+      : []),
+  ];
+}
+
 export function writePristineCatalogBackup(backupPath: string, catalogPath: string, catalog: RawCatalog): void {
```

MODIFY `src/codex/catalog/sync.ts` at current lines 507-569 and 600-616. The full
assembly remains where it is, but its output is bytes, not mutations:

```diff
-export async function syncCatalogModels(config: OcxConfig): Promise<{
+export interface PreparedCodexCatalogCommit {
   added: number;
   path: string;
-  catalogWritten: boolean;
   comboOmissions: ComboCatalogOmission[];
-}> {
+  catalogBytes: string | null;
+  cachePath: string;
+  cacheBytes: string | null;
+  backups: PreparedCatalogBackup[];
+  baseCatalogBytes: string | null;
+  notices: CatalogGatherNotice[];
+}
+
+export async function prepareCatalogSync(config: OcxConfig): Promise<PreparedCodexCatalogCommit> {
   const catalogPath = readCodexCatalogPath();
-  const catalog = loadCatalogForSync(catalogPath);
-  if (!catalog) return { added: 0, path: catalogPath, catalogWritten: false, comboOmissions: [] };
+  const catalog = loadCatalogForSync(catalogPath);
+  if (!catalog) return emptyPreparedCatalogCommit(catalogPath);
+  const baseCatalogBytes = readFileOrNull(catalogPath);
 
   // The bundled catalog is a reliable native template on the default path, but it is not the
@@
-  const onDiskCatalog = readCatalog(catalogPath);
+  const onDiskCatalog = baseCatalogBytes === null ? null : parseCatalogJson(baseCatalogBytes);
@@
-  const goModels = await gatherRoutedModels(config, { comboOmissions });
-  try {
-    // Once-only: preserve the PRISTINE pre-opencodex catalog as the native-priority baseline
-    // (later syncs would otherwise overwrite it with featured-modified priorities).
-    ensureCatalogBackup(catalogPath, catalog);
-  } catch { /* backup best-effort */ }
+  const notices: CatalogGatherNotice[] = [];
+  const goModels = await gatherRoutedModels(config, { comboOmissions, notices });
+  const backups = prepareCatalogBackups(catalogPath, catalog, baseCatalogBytes);
@@
-  atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
-  return { added: goEntries.length, path: catalogPath, catalogWritten: true, comboOmissions };
+  const catalogBytes = JSON.stringify(catalog, null, 2) + "\n";
+  const cacheBytes = JSON.stringify({
+    fetched_at: "2000-01-01T00:00:00Z",
+    client_version: "0.0.0",
+    models: catalog.models ?? catalog,
+  }, null, 2) + "\n";
+  return {
+    added: goEntries.length,
+    path: catalogPath,
+    comboOmissions,
+    catalogBytes,
+    cachePath: activeCodexModelsCachePath(),
+    cacheBytes,
+    backups,
+    baseCatalogBytes,
+    notices,
+  };
 }
+
+export function writePreparedCatalogCommit(
+  prepared: PreparedCodexCatalogCommit,
+): { result: CodexCatalogRefreshResult; writes: CatalogWriteReceipt } {
+  // No await, parsing, serialization, provider call, or subprocess below this line.
+  // Set each receipt bit only after its atomic replacement returns.
+  // Backup writes remain create-once: existsSync(path) means skip, never overwrite.
+  // On failure throw CatalogCommitDiskError carrying the receipt completed so far.
+}
```

`writePreparedCatalogCommit` performs at most four atomic replacements in this
fixed order: keyed backup, optional legacy backup, catalog, cache. The final catalog
replacement is also what materializes an absent default catalog; there is no fifth
"source" write. It creates only the parent directories needed by a prepared write.
The count never scales with providers or models. `invalidateCodexModelsCache` remains
for startup/manual cache invalidation at `src/codex/catalog/sync.ts:600-616`; it is
not called by the candidate commit.

MODIFY `src/codex/catalog/provider-fetch.ts` at current lines 410-428, 494-510, and
670-693. `resolveModelsAuthToken` rejection becomes `CatalogProviderAuthError`, and
each fallback pushes one sanitized notice with `reason` and `fallback`; no provider
name or exception text enters the public notice. The flight result carries notices
so same-key joiners receive the exact degradation set from the flight they joined,
just as `comboOmissions` is flight-local at lines 696-700.

MODIFY the facade at current `src/codex/catalog.ts:6,11-12`:

```diff
-export { isSpawnableCodexCandidate, codexExecInvocation, loadBundledCodexCatalog, materializeBundledCodexCatalog, loadCatalogTemplate } from "./catalog/bundled";
+export { isSpawnableCodexCandidate, codexExecInvocation, loadBundledCodexCatalog, materializeBundledCodexCatalog, loadCatalogForSync, loadCatalogTemplate } from "./catalog/bundled";
@@
-export { MAX_SPAWN_AGENT_MODEL_OVERRIDES, effectiveSubagentRoster, buildCatalogEntries, resetCatalogRuntimeStateForTests, orderForSubagents, mergeCatalogEntriesForSync, syncCatalogModels, restoreCodexCatalog, invalidateCodexModelsCache } from "./catalog/sync";
+export { MAX_SPAWN_AGENT_MODEL_OVERRIDES, effectiveSubagentRoster, buildCatalogEntries, resetCatalogRuntimeStateForTests, orderForSubagents, mergeCatalogEntriesForSync, prepareCatalogSync, writePreparedCatalogCommit, restoreCodexCatalog, invalidateCodexModelsCache } from "./catalog/sync";
+export type { PreparedCodexCatalogCommit } from "./catalog/sync";
```

`syncCatalogModels` is removed only after `rg -n "syncCatalogModels" src tests`
shows every production and test import migrated. This is an intentional internal
contract replacement, not a silent facade break.

### `src/codex/refresh.ts`

Replace current lines 1-27 and 34-53 with the types and operations above. The
orchestrator diff is:

```diff
-export async function refreshCodexModelCatalog(
-  config: OcxConfig,
-  deps: RefreshDeps = defaultDeps,
-): Promise<CodexCatalogRefreshResult> {
-  const result = await deps.syncCatalogModels(config);
-  const catalogExists = deps.existsSync(result.path);
-  const catalogWritten = result.catalogWritten === true;
-  const comboOmissions = result.comboOmissions ?? [];
-  if (!catalogExists) {
-    return { ...result, catalogExists, catalogWritten: false, cacheSynced: false, comboOmissions };
-  }
-  const cacheSynced = deps.invalidateCodexModelsCache();
-  return { ...result, catalogExists, catalogWritten, cacheSynced, comboOmissions };
+export async function refreshCodexModelCatalog(
+  config: OcxConfig,
+  deps: CatalogCandidateDeps = defaultCandidateDeps,
+): Promise<CodexCatalogRefreshOutcome> {
+  try {
+    const candidate = await deps.gatherCodexCatalogCandidate(config);
+    return toRefreshOutcome(deps.commitCodexCatalogCandidate(candidate));
+  } catch (error) {
+    return catalogGatherFailureOutcome(error);
+  }
 }
```

`CatalogCandidateDeps` owns only deterministic readers/writers needed to test the
candidate. Production defaults use `prepareCatalogSync`,
`writePreparedCatalogCommit`, `readConfigDiagnostics`, feature-state/path readers,
and SHA-256. Tests inject all filesystem/config observations; no test touches the
user's real home.

### Management contract and orchestrator

MODIFY `src/server/management/context.ts` at current lines 9-18 and 54-70:

```diff
+import type {
+  CatalogRefreshDisposition,
+  CodexCatalogCandidate,
+  CodexCatalogCommitResult,
+} from "../../codex/refresh";
@@
-  refreshCodexCatalog?: () => Promise<void>;
+  codexCatalog?: {
+    gather: (config: OcxConfig) => Promise<CodexCatalogCandidate>;
+    commit: (candidate: CodexCatalogCandidate) => CodexCatalogCommitResult;
+  };
@@
-  refreshCodexCatalogBestEffort: () => Promise<void>;
+  refreshCodexCatalogBestEffort: () => Promise<CatalogRefreshDisposition>;
```

The pair is one optional object so a test cannot inject gather without commit or
commit without gather. It does not own desired state or locking; WP11 wraps the
same `commit` call at the orchestrator.

MODIFY `src/server/management-api.ts` at current lines 105-113 and remove the now
dead `CatalogGatherBusyError` route-level mapper at lines 159-163. Best-effort means
non-throwing typed disposition for both production and injected paths:

```diff
-  async function refreshCodexCatalogBestEffort(): Promise<void> {
-    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
-    try {
-      const { refreshCodexModelCatalog } = await import("../codex/refresh");
-      await refreshCodexModelCatalog(config);
-    } catch {
-      /* catalog absent */
-    }
+  async function refreshCodexCatalogBestEffort(): Promise<CatalogRefreshDisposition> {
+    const refresh = await import("../codex/refresh");
+    const outcome = deps.codexCatalog
+      ? await refresh.refreshCodexModelCatalog(config, {
+          gatherCodexCatalogCandidate: deps.codexCatalog.gather,
+          commitCodexCatalogCandidate: deps.codexCatalog.commit,
+        })
+      : await refresh.refreshCodexModelCatalog(config);
+    return refresh.catalogRefreshDisposition(outcome);
   }
```

### Caller sites

Every caller captures the result immediately where it currently awaits. The
response-spread pattern is identical; the examples below cover all response shapes.

MODIFY `src/server/management/provider-routes.ts` current lines 147-148, 338-344,
487-488, and 500-547:

```diff
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ success: true, name });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ success: true, name, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
     return jsonResponse({
       success: true,
       name,
       disabled: config.providers[name]!.disabled === true,
       hasApiKey: !!config.providers[name]!.apiKey,
+      catalogRefresh,
     });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ success: true, ...(fallbackDefault ? { defaultProvider: fallbackDefault } : {}) });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ success: true, ...(fallbackDefault ? { defaultProvider: fallbackDefault } : {}), catalogRefresh });
@@
-    const respond = () => jsonResponse({ ok: true, cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
+    const respond = async () => {
+      const catalogRefresh = await refreshCodexCatalogBestEffort();
+      return jsonResponse({
+        ok: true, cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config),
+        caps: providerContextCaps(config), catalogRefresh,
+      });
+    };
@@
-      await refreshCodexCatalogBestEffort();
-      return respond();
+      return respond();
```

Apply the last two-line replacement to all three cap branches at current lines
512-513, 527-528, and 546-547.

MODIFY `src/server/management/model-routes.ts` current lines 214-215, 313-314,
352-353, 390-391, 404-405, and 440-441:

```diff
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ ok: true, disabled });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ok: true, disabled, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ ok: true, scope, provider, enabled: body.enabled, disabled });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ok: true, scope, provider, enabled: body.enabled, disabled, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse(entry, 201);
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ...entry, catalogRefresh }, 201);
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse(cm);
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ...cm, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ ok: true });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ok: true, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ ok: true, provider, selected: models });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ ok: true, provider, selected: models, catalogRefresh });
```

MODIFY `src/server/management/combo-routes.ts` current lines 198-200 and 216-217.
Capture before independent follow-up work, but do not return early:

```diff
-    await refreshCodexCatalogBestEffort();
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
     if (shouldSyncClaudeAgentDefs) await syncClaudeAgentDefsBestEffort();
-    return jsonResponse({ success: true, id, model: newPublicModel, combo: normalized });
+    return jsonResponse({ success: true, id, model: newPublicModel, combo: normalized, catalogRefresh });
@@
-    await refreshCodexCatalogBestEffort();
-    return jsonResponse({ success: true, id });
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
+    return jsonResponse({ success: true, id, catalogRefresh });
```

MODIFY `src/server/management/agent-settings-routes.ts` current lines 280-294 and
525-528:

```diff
-    await refreshCodexCatalogBestEffort();
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
@@
       agentsMaxDepthAppliesWhenV2Disabled: !enabled,
       warnings,
+      catalogRefresh,
     });
@@
-    await refreshCodexCatalogBestEffort();
+    const catalogRefresh = await refreshCodexCatalogBestEffort();
     await syncClaudeAgentDefsBestEffort();
     await autoApplyDesktopBestEffort();
-    return jsonResponse({ ok: true, applied: chosen });
+    return jsonResponse({ ok: true, applied: chosen, catalogRefresh });
```

### Explicit sync

MODIFY `src/codex/sync.ts` current lines 9-22 and 83-110. Add
`catalogRefresh?: CodexCatalogRefreshOutcome` to `CodexSyncResult` (the existing
external-provider branch at lines 56-71 performs no catalog attempt); replace the
throw/catch with a switch. `committed` fills the existing booleans from its result.
`committed` with notices sets a warning but continues injection. Ordinary gather
failure, unavailable catalog, and disk failure also continue with
`catalogPathForInjection = undefined`, preserving the pinned fallback. OFF/busy/stale
return `ok:false` before line 110 with the typed outcome attached.

MODIFY `src/server/management/config-routes.ts` current lines 261-268:

```diff
     const result = await syncModelsToCodex(undefined, config, null);
+    const status = explicitSyncHttpStatus(result.catalogRefresh, result.ok);
+    const response = jsonResponse({
       ...attachStaleAppServerHint(result),
       ...(result.ok ? {} : { error: result.message }),
-    }, result.ok ? 200 : 500);
+    }, status, req, config);
+    if (status === 503) response.headers.set("Retry-After", "1");
+    return response;
```

`jsonResponse` currently accepts exactly data, status, request, and config
(`src/server/auth-cors.ts:184-188`), so the header is set on the returned response;
do not invent a fifth argument or silently omit `Retry-After`.

## Tests

### `tests/codex-refresh.test.ts`

Replace the all-in-one dependency tests at current lines 60-216 with split cases:

1. Gather runs bundled source loading, provider discovery, assembly, serialization,
   backup preparation, and cache-wrapper preparation; injected write spies remain
   zero before commit.
2. Commit performs only the fixed write list in order. Inject every async/provider/
   parser dependency with a function that throws if called during commit.
3. `catalog_unavailable` returns skipped with no write.
4. Provider HTTP/network fallback produces committed plus a
   `provider_degraded/provider_network` notice.
5. Missing OAuth token fallback produces committed plus a
   `provider_degraded/provider_auth` notice; token-resolution throw produces
   `failed/provider_auth` with no commit.
6. `CatalogGatherBusyError` becomes retryable `skipped/gather_busy`.
7. Catalog write succeeds and cache write fails: `failed/disk`, receipt has
   `catalog:true`, `cache:false`, and the candidate is consumed.
8. A second commit of the same candidate returns `stale_candidate` and writes zero.
9. Create-once backup appears after gather: commit skips that backup, writes catalog
   and cache, and does not overwrite backup bytes.

The C2 activation cases are mandatory:

10. Gather candidate A; change one catalog-affecting persisted config field before
    commit; assert `stale_candidate`, all-false receipt, and byte-identical catalog,
    cache, and backup directory state.
11. Gather candidate A; replace the base catalog bytes with candidate B's committed
    catalog; commit A; assert `stale_candidate` and B's bytes survive.
12. Gather from absent catalog; create a catalog before commit; assert absence versus
    presence is a revision mismatch.
13. Change a non-catalog config key such as `shutdownTimeoutMs`; assert the canonical
    catalog-config digest is unchanged and commit succeeds. This prevents whole-file
    hashing from turning unrelated settings into false contention.

### Caller and sync tests

- `tests/model-visibility-management-api.test.ts`: inject gather success and commit
  `stale_candidate`; assert HTTP 200, persisted disabled state, and
  `catalogRefresh.status === "skipped"`. This is the proof that a best-effort caller
  did not become loud.
- `tests/management-provider-validation.test.ts`: retain zero refresh for standalone
  default/mode branches and exactly one paired gather/commit for ordinary edits;
  assert the response disposition.
- `tests/combo-management-api.test.ts`: DELETE removes the final combo row through
  real gather/commit; a disk failure still returns 200 with failed disposition.
- `tests/codex-v2-gate.test.ts`: scalar/feature writes remain applied when commit is
  busy or stale; route remains 200.
- `tests/codex-sync-api.test.ts`: provider network/auth and ordinary disk failures
  still invoke injection; desired OFF, gather busy, lock busy, and stale candidate
  do not. Assert the exact `CodexSyncResult.catalogRefresh` in every branch.
- `tests/codex-models-cache-invalidate.test.ts`: app-server restart hint remains
  keyed to `receipt.catalog || receipt.cache`, including partial commit.
- Fixture-only files listed in IN compile with the paired seam and never touch the
  real home.

## Verification

Static gates:

1. `bun test tests/codex-refresh.test.ts tests/codex-sync-api.test.ts tests/codex-models-cache-invalidate.test.ts`
2. `bun test tests/model-visibility-management-api.test.ts tests/management-provider-validation.test.ts tests/combo-management-api.test.ts tests/combos.test.ts tests/codex-v2-gate.test.ts`
3. `bun run typecheck`
4. `bun run test`
5. `bun run privacy:scan`
6. `bun --cwd docs-site run build`

The live proxy on 10100 is not used, restarted, synced, restored, ensured, or
stopped. Runtime proof uses isolated temporary homes and a separate process/port:

1. Create temporary `OPENCODEX_HOME` and `CODEX_HOME`, seed a known base catalog,
   and run a test harness that calls `gatherCodexCatalogCandidate` only. Before/after
   recursive file manifests must be byte-identical. This proves gather has no native
   writes, not merely that mocks saw none.
2. In the same isolated harness, mutate persisted catalog-affecting config after
   gather and call commit. Observe `stale_candidate`, all-false receipt, and
   byte-identical catalog/cache/backups. Then regather and commit; parse the catalog
   and expired cache wrapper and assert the wrapper models equal candidate catalog
   models.
3. Start an isolated proxy on a non-10100 ephemeral port with the same temporary
   homes. Send one management visibility mutation while the injected commit returns
   `stale_candidate`; observe HTTP 200, persisted mutation, and skipped disposition.
   Send explicit `/api/sync` with injected `lock_busy`; observe 503 plus
   `Retry-After: 1` and no injection write.
4. Record the before/after manifest and JSON responses in the WP9 completion section
   before moving this unit to `_fin/`. A green suite without the fired stale branch
   does not satisfy C2.

## Accept criteria

- C1 (`000_plan.md:74-75`) — `gatherCodexCatalogCandidate` performs discovery,
  loading, assembly, serialization, cache-wrapper construction, and backup
  preparation with a byte-identical isolated-home manifest; commit is synchronous
  and restricted to the fixed prepared write set. Every failure/skip is represented
  by `CodexCatalogRefreshOutcome`, and all 16 management callers report a public
  disposition while preserving their current primary success semantics.
- C2 (`000_plan.md:76-77`) — config digest mismatch, base-catalog digest/absence
  mismatch, target-home/path mismatch, and candidate reuse all return
  `stale_candidate` before any write. Tests activate both config and base-catalog
  changes and prove the newer bytes survive. WP11 later places this same synchronous
  compare-and-commit operation under the shared lock to close the remaining
  cross-process check/write window; WP9 neither assumes nor fabricates that lock.
