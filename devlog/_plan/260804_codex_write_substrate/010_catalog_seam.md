# WP9 — split Codex catalog gather from commit

Research: `001_catalog_seam.md`. Shared contract: `005_contract.md`. Read both
before implementing this diff.

The incident is still r2 #1: the active refresh combines provider discovery,
catalog assembly, native writes, and cache invalidation in one awaited function
(`src/codex/refresh.ts:40-52`, `src/codex/catalog/sync.ts:507-569,600-616`). The
16 management mutations then call a `Promise<void>` helper whose only failure
policy is a swallowed exception (`src/server/management-api.ts:105-112`,
`src/server/management/context.ts:54-69`). That shape cannot place slow gathering
outside a lock and a fixed commit inside it.

This phase fixes that catalog mechanism. It is the **first real implementation**
of the contract's `convergeCodex`. It does not define another
entry point, record, route mapping, admission shape, or shared result union. WP8b
landed those declarations without rewiring behavior (`005_contract.md` §What
"lands first"). WP9 consumes them and rewires the catalog callers in the same
commit, so this phase typechecks and preserves the callers' 2xx/201 behavior on
its own. Nothing here waits for WP10-WP12 to make the tree buildable.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`2d5e080dea3e7000bf2111b381c7c1a3c4f5fb11`.

## IN / OUT

IN — catalog mechanism:

- `src/codex/refresh.ts` (MODIFY) — opaque candidate and catalog-private gather /
  commit outcomes.
- `src/codex/catalog.ts` (MODIFY) — retain the existing facade while moving direct
  writers behind the contract's internal boundary.
- `src/codex/catalog/sync.ts` (MODIFY) — write-free preparation and one fixed,
  synchronous writer.
- `src/codex/catalog/bundled.ts` (MODIFY) — in-memory fallback during gather.
- `src/codex/catalog/parsing.ts` (MODIFY) — prepare create-once backup bytes without
  writing them.
- `src/codex/catalog/provider-fetch.ts` (MODIFY) — sanitized, catalog-private
  degradation notices.
- `src/codex/convergence.ts` (MODIFY) — implement the contract-declared
  `convergeCodex` for the first time. This phase consumes `AdmissionSnapshot`,
  `CommitExpectation`, `CatalogDisposition`, and `ConvergeOutcome` from
  `convergence-types.ts`; it does not redefine them.
- `src/codex/internal/catalog-commit.ts` (NEW/MOVE) — the prepared catalog/cache/
  backup writer, reachable only from `convergence.ts`, as required by
  `005_contract.md` §Test plan.
- `src/codex/sync.ts` (MODIFY) — delegate catalog work to `convergeCodex`; retain
  the existing ordinary-failure injection fallback until later phases replace
  more of the native path.

IN — production callers:

- `src/server/management/context.ts`, `src/server/management-api.ts` (MODIFY) —
  inject/call `convergeCodex`, not a catalog-specific orchestrator.
- `src/server/management/provider-routes.ts` (MODIFY) — six mutations report the
  contract's `CatalogDisposition` while retaining their primary status.
- `src/server/management/model-routes.ts` (MODIFY) — six mutations, same rule.
- `src/server/management/combo-routes.ts` (MODIFY) — two mutations, without
  suppressing Claude follow-up work.
- `src/server/management/agent-settings-routes.ts` (MODIFY) — two mutations,
  without suppressing Claude/Desktop follow-up work.
- `src/server/management/config-routes.ts` (MODIFY) — explicit sync calls
  `convergeCodex` and hands the result to the contract adapter.
- `structure/03_catalog-and-subagents.md`,
  `structure/05_gui-and-management-api.md` (MODIFY) — document the production
  funnel and best-effort mutation semantics.
- `docs-site/src/content/docs/reference/management-api.md` and matching `ja`,
  `ko`, `ru`, `zh-cn` pages (MODIFY) — additive `catalogRefresh`; route statuses
  are referenced from the contract, not copied into these implementation notes.

IN — tests:

- `tests/codex-refresh.test.ts`, `tests/codex-sync-api.test.ts`,
  `tests/codex-models-cache-invalidate.test.ts`,
  `tests/injection-model-api.test.ts` (MODIFY) — pure gather, fixed commit, real
  generation invalidation, and compatibility behavior.
- `tests/model-visibility-management-api.test.ts`,
  `tests/management-provider-validation.test.ts`,
  `tests/combo-management-api.test.ts`, `tests/combos.test.ts`,
  `tests/codex-v2-gate.test.ts`,
  `tests/management-integration-routes.test.ts`,
  `tests/management-client-config-route.test.ts`,
  `tests/responses-shadow-intercept.test.ts`,
  `tests/server-combo-failover-e2e.test.ts`, and
  `tests/catalog-input-modality-enum.test.ts` (MODIFY) — migrate fixtures to
  `convergeCodex`; routes that do not refresh retain zero calls.
- `tests/codex-convergence-contract.test.ts` (MODIFY) — add production module-graph
  reachability checks and the 16-caller funnel proof. WP8b created this test file;
  WP9 extends it rather than creating a second guard.

OUT:

- The `integrations/codex.json` schema and updater, `AdmissionSnapshot`,
  `CommitExpectation`, `ConvergeRequest`, `ConvergeOutcome`, `CatalogDisposition`,
  and `toSyncResponse` — owned by `005_contract.md` §§1-5. This document deletes
  its old versions instead of restating them.
- Management status/header ownership. `/api/sync` is mapped only by
  `src/server/management/sync-response.ts` (`005_contract.md` §5).
- Desired-state, ownership, journal, and provenance policy — WP12 consumes the same
  funnel and strengthens admission; WP9 does not reserve fake outcomes for it.
- The native write lock — WP11. WP9's commit is synchronous now so WP11 can wrap it
  later without changing the catalog contract.
- History isolation/locking — WP10.
- `gui/**`, transactional rollback, release/deploy actions, and the live proxy on
  port 10100.

## The catalog-private candidate

**INFERRED implementation choice:** the candidate is opaque and one-shot. Its payload is held in a module-private
`WeakMap`, so callers cannot inspect credentials, substitute bytes, serialize it,
or reconstruct a stale candidate.

```ts
const candidateBrand: unique symbol = Symbol("CodexCatalogCandidate");

export interface CodexCatalogCandidate {
  readonly [candidateBrand]: true;
}

interface CandidateState {
  readonly prepared: PreparedCodexCatalogCommit;
  readonly admittedGeneration: number;
  readonly targetIdentities: readonly CatalogTargetIdentity[];
  readonly notices: readonly CatalogGatherNotice[];
  consumed: boolean;
}

const states = new WeakMap<CodexCatalogCandidate, CandidateState>();

export async function gatherCodexCatalogCandidate(
  admission: AdmissionSnapshot,
): Promise<CodexCatalogCandidate>;

export function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
  expectation: CommitExpectation,
): CatalogCommitOutcome;
```

The exact `AdmissionSnapshot` returned by the contract admission is passed to
gather. `prepareCatalogSync` receives `admission.config` — **that object**, not the
server's captured config and not a separate `readConfigDiagnostics()` result. This
is the transfer required by `005_contract.md` §4. A gather that reopens config has
reintroduced the stale-object disagreement audit #8 identified.

Gather performs provider auth/network work, source loading, parsing, merging,
serialization, cache-wrapper construction, and backup planning. It performs no
`mkdir`, copy, write, rename, journal mutation, or integration-record update. The
isolated-home before/after manifest is the acceptance evidence for that claim.

Commit marks the candidate consumed before the first write, validates the shared
generation/identity evidence, and performs at most four atomic replacements in a
fixed order: keyed backup, optional legacy backup, catalog, cache. Retrying a
partially written candidate would replay old bytes after a later transition, so a
second call is a catalog-private `candidate-consumed` result and never writes.

## C2 — generation and target identity, not content revision

The old plan owned a `ContentRevision` and hashed config/catalog bytes. That design
is deleted. Content equality passes A→B→A, and a textual path does not reveal a
parent-symlink retarget. The shared mechanism is `005_contract.md` §3:

- `AdmissionSnapshot.generation` identifies the cooperating config generation used
  by gather;
- `CommitExpectation { nativeBefore, nativeAfter, txId }` identifies the one native
  transition this commit is allowed to perform;
- each prepared target records canonical parent identity plus file identity where
  available, not merely a path string;
- the config mutation coordinator stays held through the authoritative re-read and
  synchronous commit for cooperating writers;
- after commit, native generation must be exactly `nativeAfter` with this `txId`.

The catalog phase supplies the target observations and refuses its private commit
when the shared validator rejects them. It does not invent a third counter or a
catalog-specific revision schema.

The bound is stated narrowly. Cooperating transitions are prevented from committing
a stale candidate. A single-direction target retarget or replacement is detected.
The mechanism does **not** claim to detect an arbitrary parent-symlink A→B→A that
occurs entirely between checks; `005_contract.md` §3 explicitly scopes C17 that
way. Provider inventory changing upstream after a completed gather is also not
filesystem interference; a later convergence may supersede that snapshot.

WP9 is independently correct before WP11: its synchronous no-await commit prevents
same-process interleaving and rejects generation/identity evidence that changed
before commit. It does not claim cross-process exclusion until WP11 installs the
native lock. The catalog API does not change when that lock lands.

## Catalog-internal outcomes only

The prior document published `CodexCatalogRefreshOutcome`,
`CatalogRefreshDisposition`, and a skip-reason union that included future
`desired_off` and `lock_busy`. Those shared versions are deleted. The contract owns
the public result and management projection (`005_contract.md` §2).

WP9 keeps only facts needed inside the catalog implementation:

```ts
type CatalogGatherOutcome =
  | { kind: "prepared"; candidate: CodexCatalogCandidate }
  | { kind: "unavailable" }
  | { kind: "degraded"; candidate: CodexCatalogCandidate; notices: readonly CatalogGatherNotice[] }
  | { kind: "failed"; surface: "provider-auth" | "provider-network"; retryable: boolean };

type CatalogCommitOutcome =
  | { kind: "committed"; result: CodexCatalogRefreshResult; writes: CatalogWriteReceipt }
  | { kind: "stale"; reason: "generation" | "target-identity" | "candidate-consumed" }
  | { kind: "failed"; surface: "disk"; writes: CatalogWriteReceipt };
```

These types do not cross the `convergence.ts` boundary. `convergeCodex` projects
them into the contract's `ConvergeOutcome` and `CatalogDisposition`; no route
switches on catalog-private variants. Provider names, URLs, token text, paths,
digests, and raw exceptions never enter the public disposition. Partial disk writes
are derived from the receipt and cause a fresh convergence, never a replay of the
candidate.

## Diff — preparation and fixed writes

MODIFY `src/codex/catalog/bundled.ts` at current lines 225-234. Loading a fallback
during gather stays in memory:

```diff
 export function loadCatalogForSync(path: string): RawCatalog | null {
   return readCatalog(path)
     ?? readCatalog(catalogBackupPathFor(path))
     ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
     ?? readCatalog(activeCodexModelsCachePath())
-    ?? materializeBundledCodexCatalog(path)
     ?? loadBundledCodexCatalog();
 }
```

Retain `materializeBundledCodexCatalog` for existing explicit callers. Only gather
stops using a materializing fallback.

MODIFY `src/codex/catalog/sync.ts` at current lines 507-569 and 600-616. Assembly
returns bytes and observations; the writer accepts no config and performs no await:

```diff
-export async function syncCatalogModels(config: OcxConfig): Promise<CatalogSyncResult> {
+export async function prepareCatalogSync(
+  config: Readonly<OcxConfig>,
+): Promise<PreparedCodexCatalogCommit> {
   const catalogPath = readCodexCatalogPath();
   const baseCatalogBytes = readFileOrNull(catalogPath);
   // Existing merge logic, provider gather, backup planning, serialization.
-  atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
-  invalidateCodexModelsCache();
-  return result;
+  return {
+    catalogBytes,
+    cacheBytes,
+    backups,
+    targets: observeCatalogTargetIdentities(catalogPath, cachePath, backups),
+    result,
+    notices,
+  };
 }
+
+export function writePreparedCatalogCommit(
+  prepared: PreparedCodexCatalogCommit,
+): CatalogWriteReceipt {
+  // Fixed order; set each receipt bit only after atomic replacement returns.
+}
```

Move `writePreparedCatalogCommit` and every lower-level direct catalog/cache writer
used by convergence into `src/codex/internal/catalog-commit.ts`.
`src/codex/catalog.ts:11` currently
re-exports `syncCatalogModels`; remove that direct writer export after all production
and test imports migrate. The dependency-graph test, not an `rg` spelling guard,
proves no alias, re-export, wrapper, or dynamic import reaches the writers outside
`convergence.ts` (`005_contract.md` §Test plan).

## The first production `convergeCodex`

WP8b declared this function as a type only. WP9 now adds a non-placeholder
implementation in `src/codex/convergence.ts`:

```diff
+export async function convergeCodex(
+  request: ConvergeRequest,
+): Promise<ConvergeOutcome> {
+  const admission = inspectAdmissionSnapshot();
+  if (request.action === "observe") return observeWithoutWrite(admission);
+
+  const gathered = admission.intent === "on"
+    ? await gatherCodexCatalogCandidate(admission)
+    : null;
+
+  return coordinateCurrentNativeBehavior({
+    request,
+    admission,
+    gathered,
+    commitCatalog: commitCodexCatalogCandidate,
+  });
+}
```

`coordinateCurrentNativeBehavior` is real at this commit: it preserves the existing
apply/injection/history behavior and uses the new catalog seam. It is not a throw,
TODO, compatibility path around `convergeCodex`, or promise that WP10/WP12 must land
before WP9 works. Later phases replace mechanisms behind this same entry point.

Desired direction comes only from `admission.intent`; callers pass
`action:"converge"`, never `apply` or `remove`. Desired OFF therefore performs the
current removal path and is not a catalog `skipped` outcome (`005_contract.md` §2).

## Every management caller uses the funnel

Delete `refreshCodexCatalogBestEffort` from
`src/server/management-api.ts:105-112` and
`src/server/management/context.ts:54-69`. Replace it with one injected production
funnel:

```diff
-  refreshCodexCatalogBestEffort: () => Promise<void>;
+  convergeCodex: (request: ConvergeRequest) => Promise<ConvergeOutcome>;
```

```diff
-  async function refreshCodexCatalogBestEffort(): Promise<void> {
-    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
-    try {
-      const { refreshCodexModelCatalog } = await import("../codex/refresh");
-      await refreshCodexModelCatalog(config);
-    } catch { /* catalog absent */ }
-  }
+  const converge = deps.convergeCodex
+    ?? (await import("../codex/convergence")).convergeCodex;
```

Each of the 16 current awaits — provider 6
(`src/server/management/provider-routes.ts:147,338,487,512,527,546`), model 6
(`src/server/management/model-routes.ts:214,313,352,390,404,440`), combo 2
(`src/server/management/combo-routes.ts:198,216`), and agent settings 2
(`src/server/management/agent-settings-routes.ts:280,525`) — becomes:

```diff
-const catalogRefresh = await refreshCodexCatalogBestEffort();
+const outcome = await convergeCodex({
+  action: "converge",
+  reason: "management-mutation",
+  mode: "automatic",
+  deadlineMs: MANAGEMENT_CODEX_CONVERGENCE_DEADLINE_MS,
+});
+const catalogRefresh = outcomeCatalogDisposition(outcome);
```

`outcomeCatalogDisposition` projects only into the contract-declared
`CatalogDisposition`; it does not define a second management union. Every route
keeps its current 200/201 and the persisted mutation, appends `catalogRefresh`, and
continues unrelated Claude/Desktop work. That is the best-effort behavior promised
by `005_contract.md` §2.

## Explicit sync consumes the adapter

The old status table and manual `Retry-After` logic are deleted. The contract owns
them in `005_contract.md` §5. `src/server/management/config-routes.ts:261-268`
only invokes the funnel and adapter:

```diff
 if (url.pathname === "/api/sync" && req.method === "POST") {
-  const result = await syncModelsToCodex(undefined, config, null);
-  return jsonResponse(result, result.ok ? 200 : 500);
+  const outcome = await convergeCodex({
+    action: "converge",
+    reason: "api-sync",
+    mode: "explicit",
+    deadlineMs: EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS,
+  });
+  return toSyncResponse(outcome);
 }
```

No phase-local route helper chooses status, body, or headers. A new outcome variant
must fail the contract adapter's exhaustive `never` check, not silently take a WP9
default branch.

## Tests

### Catalog mechanism

`tests/codex-refresh.test.ts` replaces the all-in-one dependency tests with:

1. gather uses `AdmissionSnapshot.config`, performs provider/parse/assembly work,
   and leaves a real isolated-home recursive manifest byte-identical;
2. commit invokes only the fixed writer list; injected provider/parser/subprocess
   functions throw if reached beneath the synchronous boundary;
3. disk failure returns the exact partial receipt and consumes the candidate;
4. a second commit writes nothing;
5. a create-once backup appearing after gather is preserved;
6. provider auth/network degradation stays sanitized and projects through
   `ConvergeOutcome.catalogRefresh`.

### Real generation invalidation — C2/C17

The old config/content-hash tests are removed. Activation uses the production
generation owners:

1. admit/gather A; perform a cooperating persisted config transition A→B→A through
   the real config mutation API; commit A and assert generation rejection before
   every catalog/cache/backup write;
2. gather A; complete another cooperating native transition with its own `txId`;
   assert A's `CommitExpectation` is rejected and the newer bytes survive;
3. retarget a canonical parent once between gather and commit; assert target-
   identity rejection and zero writes;
4. document, but do not falsely test as guaranteed, a complete parent-symlink
   A→B→A between checks — it is outside C17's contract bound;
5. change an unrelated config field through the real config API and assert the
   generation still invalidates the candidate. Generation is transition identity,
   not semantic-field equality.

### Production funnel

- Extend `tests/codex-convergence-contract.test.ts` to walk the TypeScript module
  graph (static imports, dynamic imports, aliases, and re-exports) and prove every
  direct writer in `src/codex/internal/catalog-commit.ts` is reachable only from
  `convergence.ts`.
- Drive all 16 real management routes with an injected `convergeCodex`, assert one
  call using persisted admission rather than the route's captured config, preserve
  each primary 2xx/201, and observe the additive `catalogRefresh`.
- A refused/deferred catalog attempt must not suppress combo Claude work or agent
  settings Claude/Desktop work.
- Drive `POST /api/sync` and assert exact response behavior through
  `toSyncResponse`; do not duplicate the contract's status table in this suite.

## Verification

Static/focused gates for the WP9 commit:

```bash
bun test tests/codex-refresh.test.ts tests/codex-convergence-contract.test.ts
bun test tests/codex-sync-api.test.ts tests/codex-models-cache-invalidate.test.ts
bun test tests/model-visibility-management-api.test.ts tests/management-provider-validation.test.ts tests/combo-management-api.test.ts tests/codex-v2-gate.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun --cwd docs-site run build
```

Runtime proof uses temporary `OPENCODEX_HOME`/`CODEX_HOME` and port `0`. It never
starts, stops, syncs, restores, or ensures the live proxy on port 10100.

1. Gather only; compare full before/after manifests.
2. Fire the real config generation A→B→A transition; observe zero native writes.
3. Regather and converge; parse catalog and cache bytes and verify the cache models
   match the committed catalog.
4. Drive one best-effort management mutation through the real server boundary;
   observe its primary 2xx and contract disposition.
5. Drive explicit sync through `convergeCodex` and `toSyncResponse`.

## Accept criteria

- **C1** — gather is write-free and commit is synchronous/fixed. Catalog failures
  remain catalog-private until projected through `ConvergeOutcome`; all 16 callers
  preserve their primary success behavior and expose the contract disposition.
- **C2 / C17 (contract-scoped)** — real config/native generation changes and
  single-direction target-identity drift reject before write. No content hash or
  path string is presented as arbitrary filesystem ABA protection.
- **C14** — the production module graph proves all 16 management callers funnel
  through `convergeCodex`, and no other importer reaches the direct catalog writers.
- **N2** — the WP9 commit contains the first working `convergeCodex`, rewires its
  callers in that same commit, passes typecheck, and preserves current behavior.
  It has no placeholder whose correctness depends on WP10-WP12.
