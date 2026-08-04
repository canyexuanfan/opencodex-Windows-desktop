# WP9 — split Codex catalog gather from commit

Research: `001_catalog_seam.md`. Shared contract: `005_contract.md`. Read both
before implementing this diff.

The incident is still r2 #1: catalog refresh combines provider discovery,
catalog assembly, catalog replacement, and cache invalidation in one awaited
operation (`src/codex/refresh.ts:40-52`,
`src/codex/catalog/sync.ts:507-569,600-616`). The 16 management mutations then
call a `Promise<void>` helper that catches dynamic-import, discovery, parse, and
disk failures and discards all of them (`src/server/management-api.ts:105-112`).
That shape cannot put slow observation outside a later lock and a fixed write
sequence inside it, and it cannot tell the caller what actually happened.

WP9 lands the first real catalog-scoped `ConvergeCodex`, rewires exactly those
16 management mutation sites, and leaves the explicit sync/startup/CLI/restore
roots for WP12. A catalog-only commit updates catalog, create-once catalog
backups, and models cache only. It neither reads nor advances the native routing
pair and never writes `config.toml`, generated profile, injection journal, or
history. The transition row makes that boundary mandatory: every positive
native generation requires matching history schedule fields, every
`beginTransition` publishes that schedule, and `assertPublished` rejects a
transition that was not published (`src/codex/transition-state.ts:74-83,314-344,420-428`).

All current-code citations and diff context below were rechecked on 2026-08-04
at `de15caf449264f203cf003d032bb5f62bb448e72`. The contract citations refer to
the concurrent WP8b amendment that adds catalog source fingerprints and excludes
catalog-only work from the native pair (`005_contract.md:579-604,681-716,724-742`).

## IN / OUT

IN — observe-only admission and gather:

- `src/config.ts`, `src/codex/generation.ts` (MODIFY) — add a genuinely read-only
  generation observation that never creates, initializes, chmods, or registers
  `config-mutation.sqlite`. The existing `readConfigGeneration` is not that API:
  it resolves/records the path and opens SQLite with `create:true`
  (`src/config.ts:1741-1771,1845-1849`, `src/codex/generation.ts:93-103`).
- `src/codex/catalog-admission.ts` (MODIFY) — keep the landed request constructor
  and snapshot capture; switch snapshot capture to the observe-only generation
  read and carry the contract-owned source-fingerprint list. Do not redefine
  `createCatalogConvergeRequest` or `captureCatalogAdmissionSnapshot`, which
  already exist at lines 32-46 and 84-107.
- `src/codex/convergence-types.ts` (MODIFY) — synchronize the already contract-owned
  `CatalogSourceFingerprint` and `CatalogAdmissionSnapshot.sourceFingerprints`
  additions from `005_contract.md`; no WP9-private duplicate type is allowed.
- `src/codex/runtime.ts`, `src/codex/catalog/bundled.ts` (MODIFY) — catalog gather
  resolves the runtime through the existing non-persisting `resolveCodexRuntime`
  (`src/codex/runtime.ts:394-405`), never
  `resolveAndPersistCodexRuntime`, whose successful path may mkdir and replace
  `codex-runtime.json` (`src/codex/runtime.ts:213-228,500-516`,
  `src/codex/catalog/bundled.ts:146-169`).
- `src/oauth/index.ts`, `src/oauth/store.ts`,
  `src/codex/catalog/provider-fetch.ts` (MODIFY) — add and consume an observe-only
  active-token snapshot based on `peekAuthStore`, which already promises no
  chmod or invalid-file backup (`src/oauth/store.ts:145-157`). It never refreshes,
  persists, acquires an intent lock, creates/removes an intent file, hardens a
  path, or backs up malformed credentials. The current token resolver can enter
  refresh/persistence (`src/oauth/index.ts:281-339,352-354`) and the current gather
  awaits it (`src/codex/catalog/provider-fetch.ts:410-428`).
- `src/codex/refresh.ts`, `src/codex/catalog/sync.ts`,
  `src/codex/catalog/parsing.ts` (MODIFY) — prepare immutable catalog/cache/backup
  bytes and source evidence without writing.

IN — fixed commit and convergence:

- `src/codex/internal/catalog-writer.ts` (NEW/MOVE) — the contract-owned low-level
  owner for catalog, hashed/legacy backups, and models cache. Do not create the
  obsolete `internal/catalog-commit.ts` name
  (`005_contract.md:1019,1025-1026`).
- `src/codex/convergence.ts` (NEW) — catalog gather/commit orchestration and the
  only WP9 module allowed to call symbols in `internal/catalog-writer.ts`.
- `src/codex/management-convergence.ts` (MODIFY) — retain the landed
  management-only factory and catalog-only projection, but replace the placeholder
  body at lines 81-96 with the real call into `convergence.ts`. The factory keeps
  the exact config reference it already captures; no second factory or projection
  is introduced.
- `src/codex/catalog.ts` (MODIFY) — preserve reader/pure exports while removing
  direct writer re-exports from the public facade after legacy callers have explicit
  imports. It currently re-exports `syncCatalogModels`, `restoreCodexCatalog`, and
  `invalidateCodexModelsCache` together (`src/codex/catalog.ts:1-11`).

IN — management callers and tests:

- `src/server/management-api.ts`, `src/server/management/context.ts`, and the four
  invoking route modules (MODIFY) — replace the swallowed helper with a total,
  lazy catalog-convergence adapter returning `CatalogDisposition`.
- `src/codex/sync.ts`, `src/server/management/config-routes.ts`,
  `src/server/index.ts`, `src/cli/index.ts`, and `src/codex/inject.ts` (IMPORT-ONLY)
  — keep the four legacy roots compiling after the public facade stops re-exporting
  writers. Their behavior and ownership do not move until WP12.
- `tests/codex-refresh.test.ts` and the existing management route suites (MODIFY).
- `tests/codex-convergence-contract.test.ts` (CREATE). It does not exist in the
  WP8b tree; WP9 creates it rather than “extending” an imaginary file.

OUT:

- WP10 history scheduling/worker behavior. Catalog-only work schedules no history.
- WP11 native lock acquisition. WP9 makes commit synchronous but does not import a
  future lock helper or claim cross-process exclusion.
- WP12 full admission/observer/provenance, full `scope:"full"` convergence,
  `/api/sync`, startup, CLI cache sync, restore, and complete writer reachability.
- Any runtime command that starts, stops, syncs, restores, ensures, or manages the
  live service; any write to real `~/.codex` or `~/.opencodex`; GUI/release/deploy.

WP9 typechecks at its own commit. `management-convergence.ts` contains working
catalog behavior, not a placeholder waiting for WP12. WP12 may consolidate the
management factory/projection into `convergence.ts` when it installs the full
entry point; that later move is a module consolidation, not completion of an
unfinished WP9 branch.

## A. Filesystem-write-free gather

### A1 — state the guarantee exactly

The guarantee is **filesystem-write-free**, not globally side-effect-free. Gather
may update bounded process-local memo, discovery-status, provider model cache, and
in-flight admission maps. Those mutations already occur at
`src/codex/runtime.ts:362-405` and
`src/codex/catalog/provider-fetch.ts:455-465,495-507,608-615,675-685`; they are
permitted because they do not mutate user files and are reset between isolated
tests. No credential, raw provider error, source path, or digest may escape through
those caches into `CatalogDisposition`.

Filesystem-write-free means the entire interval from **before admission capture**
through resolved runtime observation, token observation, provider calls, fallback
selection, parsing, serialization, and candidate construction performs no mkdir,
write, rename, copy, unlink, chmod/ACL change, SQLite create/init/WAL change,
ownership registration, backup, or transient temp-file creation.

This bound deliberately catches the writes hidden by the old plan:

- runtime selection must not persist `codex-runtime.json`;
- ordinary auth reads must not call `loadAuthStoreInternal`, whose read path
  hardens files and backs up invalid JSON (`src/oauth/store.ts:128-137`);
- expired OAuth is a sanitized provider-auth degradation/failure for this gather,
  not permission to refresh and persist;
- admission must not invoke the create-on-read generation path, which can also
  register ownership metadata (`src/lib/config-ownership.ts:202-226,262-282`).

The observe-only generation API opens an existing database with `readonly:true`,
performs only schema/version/select checks, and closes it. Missing DB/table/row,
busy, malformed, or unreadable state returns the existing typed unavailable result;
it never initializes generation zero. `captureCatalogAdmissionSnapshot` projects
that result into a typed catalog refusal through the total adapter.

The observe-only token snapshot reads the active credential once from
`peekAuthStore`. A non-expired access token may be used. Missing, malformed,
near-expiry, or expired OAuth credentials yield provider-auth without calling any
refresh path. Static API keys and request headers already present in the admitted
`Readonly<OcxConfig>` remain usable. If the auth-store buffer influences a live
provider result, its canonical path and SHA-256 join the candidate's private source
fingerprints; token bytes never do.

### A2 — fingerprint the exact buffers that influenced output

`captureCatalogAdmissionSnapshot(config)` remains the pre-gather constructor and
starts with the contract-required empty `sourceFingerprints`. Each gather reader
returns bytes and a `CatalogSourceFingerprint` computed from that **same buffer**.
The candidate receives an immutable snapshot copy containing exactly the sources
actually selected or merged:

- active catalog bytes when read as the merge source;
- the selected hashed backup, legacy backup, or models-cache fallback;
- persisted runtime-selection or auth-store bytes when those reads influenced
  runtime/token selection;
- any later file buffer that affects candidate bytes.

Do not fingerprint alternatives merely because their paths exist, and do not hash a
separate pre-read. Process-local caches and subprocess/network responses are not file
buffers and therefore are not fabricated as file fingerprints.

Immediately before the first replacement, commit re-reads every candidate-bound
source by canonical path. Digest mismatch returns `stale`; unreadable,
unresolvable, non-regular, or ambiguous source identity returns `refused`. Both
paths write zero bytes. This detects the audited same-inode truncate/rewrite even
when config generation and target dev/inode are unchanged. It catches
single-direction drift only: content A→B→A returning identical bytes before the
comparison, a parent A→B→A between checks, and a write after the final comparison
remain outside C17 (`005_contract.md:681-716`).

### A3 — preserve bundled-first template precedence

`loadCatalogForSync` keeps its current default-path branch: obtain the bundled
catalog first and clone it as the native template; read the on-disk catalog
separately as the merge source. The invariant is explicit at
`structure/03_catalog-and-subagents.md:23-27` and implemented at
`src/codex/catalog/bundled.ts:225-234` plus
`src/codex/catalog/sync.ts:517-523`.

The WP9 edit removes only the materializing fallback call from the tail of
`loadCatalogForSync`; it does not move catalog/backup/cache ahead of a successful
bundled template. The bundled branch uses observe-only runtime resolution. Existing
explicit materialization callers remain until their owning phase migrates them.

### A4 — candidate ownership

The candidate remains opaque, one-shot, and catalog-private. Its `WeakMap` state
contains prepared bytes, result/notices, target identities, the admitted config
generation, and the populated candidate-bound source fingerprints. Commit marks it
consumed before validation and before the first write; a second call returns
`candidate-consumed` and writes nothing. No route can inspect, serialize,
reconstruct, or replay it.

Only catalog-private outcomes are added here:

```ts
export interface CatalogWriteReceipt {
  readonly keyedBackup: "written" | "preserved" | "not-requested";
  readonly legacyBackup: "written" | "preserved" | "not-requested";
  readonly catalog: "written" | "not-written";
  readonly cache: "written" | "not-written";
}

export type CodexCatalogCommitResult =
  | { readonly kind: "committed"; readonly changed: boolean; readonly writes: CatalogWriteReceipt }
  | { readonly kind: "stale"; readonly reason: "generation" | "source-fingerprint" | "target-identity" | "candidate-consumed" }
  | { readonly kind: "refused"; readonly reason: "source-unreadable" | "source-ambiguous" | "target-unsafe" }
  | { readonly kind: "failed"; readonly surface: "disk"; readonly writes: CatalogWriteReceipt };
```

`convergence.ts` projects those private variants into the contract's existing
`CatalogDisposition`; routes never switch on this union.

## B. Fixed synchronous commit

Preparation returns exact catalog/cache bytes and optional create-once backup bytes.
`internal/catalog-writer.ts` accepts only that prepared value and synchronous
filesystem dependencies. It accepts no config, provider client, parser, subprocess,
OAuth resolver, Promise, or callback that can return a Promise.

Commit performs, in order:

1. validate candidate not consumed, config generation, every target identity, and
   every source fingerprint;
2. keyed backup create-once replacement;
3. legacy backup create-once replacement when the default path requests it;
4. active catalog replacement;
5. models cache replacement.

Receipt fields change only after the corresponding replacement succeeds. A failure
returns the exact prefix receipt and consumes the candidate; callers must regather.
There is no rollback claim.

Target identity remains strict except for one create-once rule. If a backup target
was absent at gather and is present at commit, commit may mark it `preserved` and
continue only when the target is a safely resolved regular file, readable, and a
valid non-routed catalog backup. It is never overwritten. A symlink, unreadable
file, malformed JSON/catalog, routed-content backup, or ambiguous identity is
`refused` before the first write. This exception applies only to a backup used as a
create-once target, never to a backup whose bytes were selected as a gather source;
selected source fingerprints remain strict.

## C. Catalog-only convergence

### C1 — consume the WP8b seams

WP9 does not redeclare request, snapshot, projection, or shared result types.
`management-convergence.ts` consumes:

- `createCatalogConvergeRequest` from
  `src/codex/catalog-admission.ts:32-46`;
- `captureCatalogAdmissionSnapshot` from
  `src/codex/catalog-admission.ts:84-107`;
- `projectCatalogOnlyOutcome` from its landed owner at
  `src/codex/management-convergence.ts:63-75`;
- shared `CatalogDisposition`, `ConvergeOutcome`, and `ConvergeCodex` from
  `convergence-types.ts`.

The placeholder factory body at `src/codex/management-convergence.ts:81-96` is
replaced in place. It validates catalog scope without throwing, captures admission,
awaits the write-free gather, executes the synchronous commit, and projects the
result. The lower-level orchestration lives in new `convergence.ts`, so only that
module reaches `internal/catalog-writer.ts`; the retained management module remains
the factory boundary until WP12 consolidates the full funnel.

### C2 — config generation, source fingerprints, and target identity only

A `scope:"catalog"` commit does not request `CommitExpectation`, open
`transition-state.ts`, call `beginCodexTransition`, call `assertPublished`, or read
or advance `{nativeGeneration,currentTxId}`. Its `catalog-only` outcome correctly
has no pair fields (`src/codex/convergence-types.ts:207-224`).

Catalog staleness is guarded by:

- the observe-only config generation captured before gather and re-read immediately
  before write;
- candidate-bound per-source fingerprints;
- target parent/file identity plus the narrow create-once backup exception.

The commit must never import or invoke routing writers. A test fails if catalog-only
work changes `config.toml`, generated profile, journal, transition row, or history.

### C3 — total, non-throwing management adapter

Delete `refreshCodexCatalogBestEffort` from
`src/server/management-api.ts:105-113` and its context field at
`src/server/management/context.ts:68`. Replace the dependency with a factory seam
for `createManagementConvergeCodex(config)` and expose one context adapter such as
`convergeCodexCatalog(): Promise<CatalogDisposition>`.

That adapter is total. One outer `try/catch` covers request construction, lazy
dynamic import, missing export, factory construction, admission, gather, commit,
projection, and malformed/unexpected outcomes. Expected private results map
directly. The adapter tracks whether commit began and the commit function catches
every expected replacement failure into a receipt, so even an unexpected throw has
a conservative typed projection:

| Internal condition | `CatalogDisposition` projection |
|---|---|
| gather admission busy | `skipped/busy`, retryable |
| no usable catalog source | `skipped/catalog-unavailable` |
| config/target/source refusal | `skipped/refused` |
| generation, fingerprint, or identity drift | `skipped/stale`, retryable |
| provider auth/network gather failure | matching `failed` reason, `phase:"gather"`, `partialWrite:false` |
| lazy import, missing export, factory, or unexpected pre-commit failure | sanitized `failed/disk`, `phase:"gather"`, `partialWrite:false` |
| expected replacement failure | `failed/disk`, `phase:"commit"`, `partialWrite` derived from the receipt |
| unexpected throw after commit begins | `failed/disk`, `phase:"commit"`, `partialWrite:true` (fail closed) |

No raw message, provider, token, path, or digest reaches the response. The route
dispatcher may continue to rethrow unrelated errors at
`src/server/management-api.ts:150-163`; no catalog error escapes to it.

The lazy binding is cached only after factory construction succeeds. A failed lazy
import/factory remains retryable on a later mutation instead of caching a broken
closure. The factory closure itself is also total, including wrong-scope input.

Each current await becomes one adapter call and appends its returned disposition.
The complete invocation set remains provider 6
(`src/server/management/provider-routes.ts:147,338,487,512,527,546`), model 6
(`src/server/management/model-routes.ts:214,313,352,390,404,440`), combo 2
(`src/server/management/combo-routes.ts:198,216`), and agent settings 2
(`src/server/management/agent-settings-routes.ts:280,525`).

Order is part of compatibility:

- `/api/v2` keeps its intentional Codex config writes before catalog convergence
  (`src/server/management/agent-settings-routes.ts:230-280`);
- combo update keeps save/reconcile/cooldown work, then convergence, then optional
  Claude definition sync (`src/server/management/combo-routes.ts:188-200`);
- `/api/subagent-models` keeps save, convergence, Claude sync, Desktop apply, response
  (`src/server/management/agent-settings-routes.ts:518-528`).

Therefore “no additional writes” is asserted around the convergence call itself,
not around the whole route. Route tests separately assert the existing primary and
follow-up writes still execute in their original order after every committed,
skipped, refused, failed, lazy-import-failed, and factory-failed disposition.

## D. WP9 reachability, bounded honestly

WP9's C14 claim is only that the 16 management mutation sites no longer reach
`refreshCodexCatalogBestEffort` or catalog writers and instead pass through the
catalog-scoped `ConvergeCodex`. It does **not** claim that `convergence.ts` is the
repository's sole catalog writer root yet.

The symbol-graph test permits these exact legacy roots until WP12:

| Legacy root | Current path | WP12 removal |
|---|---|---|
| management `POST /api/sync` | `config-routes.ts:261-268` → `sync.ts:83-89` → `refresh.ts:44-51` | rewire to full convergence and `toSyncResponse` |
| server startup cache invalidation | `server/index.ts:403` → `invalidateCodexModelsCache` | route startup through full convergence/observer |
| `ocx sync-cache` | `cli/index.ts:849-855` → `invalidateCodexModelsCache` | route CLI command through full convergence |
| native restore | `codex/inject.ts:764-774` → `restoreCodexCatalog` → `catalog/sync.ts:572-597` | move restore writes behind full convergence/provenance |

The allowlist is exact by root module and writer symbol, not a directory wildcard.
WP12 owns deleting every row. No new legacy root may be added in WP9.

`tests/codex-convergence-contract.test.ts` is created with a TypeScript-resolved,
symbol-granular graph: static imports, literal dynamic imports, path aliases,
re-exports, renamed imports, namespace property access, and wrappers all preserve
the writer symbol identity. An unresolved module, unresolved symbol, computed
dynamic import, or non-literal import that could hide a writer fails the test rather
than being skipped. The test publishes the WP9 legacy allowlist as data and proves
all 16 management roots terminate at `convergence.ts` before a catalog writer.

## Tests

### T1 — gather really performs no filesystem write

Run admission plus gather in a child process with fresh `mktemp -d` values for
`OPENCODEX_HOME`, `CODEX_HOME`, and any config/runtime home. Capture the recursive
manifest **before calling `captureCatalogAdmissionSnapshot`**, not after admission.
For every entry record relative path, kind, regular-file SHA-256, size, mode,
mtime at nanosecond resolution where available, and symlink target. Compare it
after gather.

Start a recursive filesystem event journal before admission and stop it after gather;
fail on create/delete/rename/write/metadata events so a temp file created and deleted
within the interval is visible. Prove the harness is non-vacuous with controls that
(a) chmod an existing file and (b) create then delete a temp file; both must fail.
Also inject throw-on-call spies for runtime persistence, OAuth refresh/persist/intent,
ownership registration, generation initialization, backup creation, and atomic
replacement. Reset and separately assert the permitted process-local caches changed
only within their bounded owners.

Broken mutation that must turn T1 red: replace observe-only runtime resolution with
`resolveAndPersistCodexRuntime`, use `loadAuthStore`, or use
`readConfigGeneration`; the manifest/event journal or write spy detects the mkdir,
chmod, backup, SQLite, ownership, or temp-file activity.

### T2 — fingerprints and identity reject before write

Table-drive active catalog, selected hashed backup, selected legacy backup, selected
models-cache fallback, runtime-state source, and auth-store source. Gather at config
generation N, truncate and rewrite the selected source **in place** so dev/inode and
generation remain the same, then commit. Expect `stale` and byte-identical targets.
Make each source unreadable/ambiguous and expect `refused` with zero writes. Change
config through the real cooperating mutation API and expect generation rejection.
Retarget one parent and expect target-identity rejection.

Document but do not claim detection for content A→B→A returning exact A before the
comparison, parent A→B→A entirely between checks, or a write after the comparison.

Broken mutation that must turn T2 red: remove fingerprint comparison while retaining
generation and inode checks; the same-generation same-inode rewrite would commit and
the old candidate bytes would replace the newer source-derived state.

### T3 — exact four-step receipt and bytes

Inject failure immediately before each replacement and assert both receipt and real
target bytes:

| Failure before | Expected completed prefix | Required byte state |
|---|---|---|
| keyed backup | none | all four targets retain pre-image |
| legacy backup | keyed only | keyed has candidate bytes; legacy/catalog/cache retain pre-image |
| catalog | keyed + legacy | both backups have candidate bytes; catalog/cache retain pre-image |
| cache | keyed + legacy + catalog | backups/catalog have candidate bytes; cache retains pre-image |

Every row also proves the candidate is consumed and a second commit writes nothing.
Repeat backup absent→present with a valid non-routed backup and expect `preserved`;
repeat with malformed, unreadable, routed, symlinked, and ambiguous appearing backups
and expect refusal before any replacement.

Broken mutation that must turn T3 red: set a receipt bit before replacement or catch
a failed replacement and continue; receipt and actual bytes diverge in at least one
table row.

### T4 — total adapter and route ordering

Drive all 16 real routes with a factory spy and assert reference equality with the
exact config passed to `handleManagementAPI`, one fixed request created by
`createCatalogConvergeRequest`, original 2xx/201, and additive
`catalogRefresh`. Table-drive lazy-import rejection, missing export, throwing factory,
generation unavailable, gather auth/network failure, stale/refused commit, disk
failure before each replacement, and malformed result. None may throw or skip later
work.

Scope the routing-write spies to the convergence call itself. Separately record route
events and assert the original order for `/api/v2`, combo update, and
`/api/subagent-models`, including Claude/Desktop follow-ups after every catalog
disposition.

Broken mutation that must turn T4 red: remove the adapter's outer catch; a lazy-import
or snapshot error reaches the dispatcher, changes the persisted-success route to 500,
and the event log lacks later Claude/Desktop calls.

### T5 — lazy loading and reachability

For laziness, launch a child process that registers a Bun module-load sentinel for
the canonical `src/codex/management-convergence.ts`, imports management API, and
drives only non-refresh routes. The sentinel must remain zero; a second child drives
one catalog mutation and observes one initialization. A route-level “zero calls” spy
alone is not accepted because an eager static import would pass it.

For reachability, run the symbol graph described in D. It must accept only the four
legacy rows and reject aliases, re-exports, wrappers, or dynamic imports from any new
root.

Broken mutations that must turn T5 red: add a static top-level management-convergence
import, alias a catalog writer into a management route, or replace a literal import
with a computed dynamic import. The sentinel or fail-closed graph must reject each.

### T6 — precedence and native-pair exclusion

On the default catalog path, provide a bundled template that differs visibly from
catalog/backup/cache plus an on-disk routed/user-native row. Gather must use bundled
native template fields and preserve the on-disk merge row. Assert no materialized
fallback write. Snapshot the transition row before and after committed, stale,
refused, and failed catalog-only attempts; it must be byte/field identical and no
history schedule appears. Routing artifact spies stay zero.

Broken mutations that must turn T6 red: move disk fallbacks ahead of bundled lookup,
request `CommitExpectation`, or call a routing writer. Template assertions, transition
row equality, or routing spies fail.

## Verification

Static/focused gates for the WP9 commit:

```bash
bun test tests/codex-refresh.test.ts tests/codex-convergence-contract.test.ts
bun test tests/codex-config-generation.test.ts tests/codex-sync-api.test.ts tests/codex-models-cache-invalidate.test.ts
bun test tests/model-visibility-management-api.test.ts tests/management-provider-validation.test.ts tests/combo-management-api.test.ts tests/codex-v2-gate.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun --cwd docs-site run build
```

Runtime probes use temporary homes and child processes only. They do not invoke
`ocx start`, `stop`, `sync`, `restore`, `ensure`, any `ocx service` command, or the
live proxy on port 10100.

## Accept criteria

| Criterion | Proof | Concrete broken mutation that makes it red |
|---|---|---|
| **C1** — gather is filesystem-write-free; commit is synchronous, fixed, one-shot, and receipt-exact | T1 + T3 | call a persisting resolver/read, add an `await` beneath commit, reorder replacements, pre-set a receipt bit, or replay a consumed candidate |
| **C2/C17** — config generation, every consumed source fingerprint, and target identity reject stale work before write, with only the valid create-once backup exception | T2 + T3 | in-place rewrite the same inode at the same generation, omit one selected fallback fingerprint, accept unreadable source, or overwrite an appearing backup |
| **Catalog/native boundary** — catalog-only never reads/advances the native pair or writes routing/history artifacts | T6 | call `expectation()`/`beginTransition`, add pair fields to `catalog-only`, or invoke config/profile/journal/history writer |
| **Best-effort compatibility** — all 16 primary writes retain 2xx/201 and original follow-up order for every catalog failure | T4 | let lazy import/factory/admission throw, scope “zero writes” to the whole route, or return before Claude/Desktop follow-up |
| **C14, WP9-bounded** — the 16 management roots reach catalog writers only through convergence; exactly four documented legacy roots remain until WP12 | T5 symbol graph | add a fifth root, hide one through alias/re-export/computed import, or accidentally require WP12 to have already removed `/api/sync`/startup/CLI/restore |
| **N2** — WP9 replaces the landed placeholder, consumes existing request/snapshot/projection seams, creates the contract test, and typechecks without WP10-WP12 | focused tests + typecheck | redefine a WP8b type/helper, refer to a nonexistent later helper, leave a throwing placeholder, or claim the absent test file is merely extended |
