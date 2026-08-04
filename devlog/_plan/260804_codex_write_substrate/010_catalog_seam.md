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
of the contract's `convergeCodex`, but the earlier decision to send management
mutations through full apply/injection/history convergence is reversed. Those 16
callers currently refresh catalog and cache only
(`src/server/management-api.ts:105-112`, `src/codex/refresh.ts:40-52`); changing a
provider must not start rewriting `config.toml`, profile, journal, or history in the
WP9 commit. WP9 therefore implements a catalog-scoped request and rewires only that
behavior. WP12 installs the authoritative full funnel and rewires `/api/sync` and
the remaining lifecycle callers after WP10-WP11 supply their safety mechanics.

WP9 does not define another entry point, record, route mapping, admission shape, or
shared result union. WP8b lands the minimal concrete primitives listed below, not
declarations that require WP12 to become executable. WP9 consumes them and rewires
the catalog callers in the same commit, so this phase typechecks and preserves the
callers' 2xx/201 and native-write behavior on its own.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`47e7cac27723fa09dd7bb1bacac402b1e579b358`.

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
  `convergeCodex` for the first time. The management path consumes the catalog-scoped
  request/snapshot, generation tokens, `CatalogDisposition`, and `ConvergeOutcome`
  from `convergence-types.ts`; it does not call WP12's full admission or observer.
- `src/codex/internal/catalog-commit.ts` (NEW/MOVE) — the prepared catalog/cache/
  backup writer, reachable only from `convergence.ts`, as required by
  `005_contract.md` §Test plan.
- `src/codex/sync.ts` (NO CHANGE) — explicit sync remains on its current full native
  path in WP9. WP12 rewires it after the full admission/observation mechanics exist.

IN — production callers:

- `src/server/management/context.ts`, `src/server/management-api.ts` (MODIFY) —
  inject/call `convergeCodex` with `scope: "catalog"`, not a catalog-specific entry
  point and not the full convergence scope.
- `src/server/management/provider-routes.ts` (MODIFY) — six mutations report the
  contract's `CatalogDisposition` while retaining their primary status.
- `src/server/management/model-routes.ts` (MODIFY) — six mutations, same rule.
- `src/server/management/combo-routes.ts` (MODIFY) — two mutations, without
  suppressing Claude follow-up work.
- `src/server/management/agent-settings-routes.ts` (MODIFY) — two mutations,
  without suppressing Claude/Desktop follow-up work.
- `src/server/management/config-routes.ts` (NO CHANGE) — WP9 leaves explicit sync at
  current lines 261-268; WP12 moves it to full convergence and the contract adapter.
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
  `src/server/management/sync-response.ts` (`005_contract.md` §5), but WP12 is the
  phase that first connects that adapter to the production route.
- Desired-state, ownership, journal, and provenance policy — WP12 consumes the same
  funnel and strengthens admission; WP9 does not reserve fake outcomes for it.
- The native write lock — WP11. WP9's commit is synchronous now so WP11 can wrap it
  later without changing the catalog contract.
- History isolation/locking — WP10.
- Full admission, observed-state projection, apply/remove direction, and production
  `/api/sync`/lifecycle rewiring — WP12. WP9 must not call their future helpers.
- `gui/**`, transactional rollback, release/deploy actions, and the live proxy on
  port 10100.

## WP8b prerequisites that make WP9 self-contained

The earlier draft assumed `inspectAdmissionSnapshot`, config/native generation
owners, and observed-state projection would already exist. They do not: WP12 owns
the full authority read and observer (`040_ownership_convergence.md:42,119-157,327-378`).
A WP9 diff that calls those helpers cannot land independently.

WP8b must therefore add these minimal **working** primitives before WP9, with focused
typecheck/tests in the WP8b commit:

1. `ConvergeRequest.scope` with at least `"catalog" | "full"`, plus a concrete
   catalog request constructor. The production management callbacks use only
   `scope: "catalog"`; `"full"` remains the compatibility/current-behavior branch
   until WP12 replaces it with authoritative admission.
2. A concrete `CatalogAdmissionSnapshot` plus catalog-scoped snapshot reader that
   accepts the same `OcxConfig` object the current callback already uses and captures
   only the config generation and catalog target identities WP9 validates. It
   performs no service ownership, external-provider, journal, provenance, desired-
   state, history, or observed-state work and is not `inspectAdmissionSnapshot`.
3. Concrete config/native generation owners: every cooperating persisted-config
   commit bumps the config generation through the existing config mutation owner,
   and the integration-record owner reads/advances native generation plus `txId`.
   WP9 may consume those tokens; it may not assume WP12 will add their storage or
   bump sites later.
4. One contract projection for catalog-only completion. WP9 supplies the real
   `CatalogDisposition`; history and observed sections are synthesized as
   **no-change/not-evaluated**, never by invoking WP10 history or WP12 observation.

These are substrate primitives, not a partial ownership implementation. WP12 still
owns the authoritative full `AdmissionSnapshot`, fresh under-coordination re-read,
authority/provenance checks, real observed-state projection, and full caller funnel.
Moving the concrete generation owners forward is an explicit ownership correction
to `040_ownership_convergence.md:42`: WP12 consumes those WP8b owners instead of
introducing them after WP9 has already depended on them.

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
  admission: CatalogAdmissionSnapshot,
): Promise<CodexCatalogCandidate>;

export function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
  expectation: CommitExpectation,
): CatalogCommitOutcome;
```

The catalog-scoped snapshot receives the same config object the current management
callback already uses. `prepareCatalogSync` receives `admission.config` — **that
object**, not a separate `readConfigDiagnostics()` result. The generation token
detects a cooperating persisted transition before commit. WP12 later replaces this
limited input with its authoritative full admission; WP9 does not import that future
helper.

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

## The first production `convergeCodex` is catalog-scoped for management

WP8b declared this function as a type only. WP9 now adds a non-placeholder
implementation in `src/codex/convergence.ts`:

```diff
+export async function convergeCodex(
+  request: ConvergeRequest,
+): Promise<ConvergeOutcome> {
+  if (request.scope === "catalog") {
+    const admission = captureCatalogAdmissionSnapshot(request);
+    const gathered = await gatherCodexCatalogCandidate(admission);
+    const catalog = commitCatalogAgainstCurrentGeneration(admission, gathered);
+    return projectCatalogOnlyOutcome(catalog, {
+      history: "no-change",
+      observed: "no-change-not-evaluated",
+    });
+  }
+
+  return coordinateLegacyFullBehavior(request);
+}
```

`projectCatalogOnlyOutcome` reports the actual catalog/cache/backup result and
synthesizes history and observed fields as no-change/not-evaluated. It never calls
config injection, profile, journal, history, restoration, or WP12 observation.
`coordinateLegacyFullBehavior` is only a typed adapter over the existing full path;
WP9 does not route management or `/api/sync` into it. WP12 replaces that branch with
the authoritative full funnel and rewires the production full callers. This is a
plain reversal of the earlier WP9 design, which had made provider/model edits perform
full native convergence before its safety phases existed.

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
+  scope: "catalog",
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

## Explicit sync is deliberately not rewired in WP9

`src/server/management/config-routes.ts:261-268` continues to call
`syncModelsToCodex(undefined, config, null)` in the WP9 commit. Moving that route to
`convergeCodex` here would require the full admission, observed-state projection,
history safety, and response semantics that WP10-WP12 have not landed. WP12 performs
the real diff to `scope: "full"` plus `toSyncResponse`; until then the current route
status/body behavior remains unchanged.

## Tests

### Catalog mechanism

`tests/codex-refresh.test.ts` replaces the all-in-one dependency tests with:

1. gather uses `CatalogAdmissionSnapshot.config`, performs provider/parse/assembly work,
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
  `scope: "catalog"` call using the same config object as today's callback, preserve
  each primary 2xx/201, and observe the additive `catalogRefresh`.
- For every management route, inject spies that fail on config/profile/journal/history
  writes and assert zero calls; assert history and observed result sections are the
  contract's no-change/not-evaluated projection.
- A refused/deferred catalog attempt must not suppress combo Claude work or agent
  settings Claude/Desktop work.
- Drive `POST /api/sync` and assert it still follows the pre-WP9
  `syncModelsToCodex` route behavior. The `toSyncResponse` production proof belongs
  to WP12/WP13.

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
5. Drive explicit sync and prove WP9 left its current route behavior unchanged.

## Accept criteria

- **C1** — gather is write-free and commit is synchronous/fixed. Catalog failures
  remain catalog-private until projected through `ConvergeOutcome`; all 16 callers
  preserve their primary success behavior and expose the contract disposition.
  Their request is `scope: "catalog"`; config/profile/journal/history write spies stay
  at zero, and history/observed fields are no-change/not-evaluated.
- **C2 / C17 (contract-scoped)** — real config/native generation changes and
  single-direction target-identity drift reject before write. No content hash or
  path string is presented as arbitrary filesystem ABA protection.
- **C14** — the production module graph proves all 16 management callers funnel
  through `convergeCodex`, and no other importer reaches the direct catalog writers.
- **N2** — the WP9 commit contains the first working `convergeCodex`, rewires its
  callers in that same commit, passes typecheck, and preserves current behavior.
  WP8b already supplies the concrete catalog snapshot/request/projection and both
  generation owners; WP9 calls no WP12 admission or observer placeholder. WP12 is
  explicitly the phase that replaces the legacy full branch and rewires full callers.
