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
at `db3d69ed05bba5c2dd822f2c2088c186adf5a105`. The contract citations refer to
the authoritative concurrent WP8b/WP9 amendment: the owner-held config-generation
guard, closed source-observation union, and atomic no-clobber publication are at
`005_contract.md:615-645,722-784,792-918,923-938`; catalog-only work remains
excluded from the native pair at `005_contract.md:588-613`.

## IN / OUT

IN — observe-only admission and gather:

- `src/config.ts`, `src/codex/generation.ts` (MODIFY) — add a genuinely read-only
  generation observation that never creates, initializes, chmods, or registers
  `config-mutation.sqlite`. The existing `readConfigGeneration` is not that API:
  it resolves/records the path and opens SQLite with `create:true`
  (`src/config.ts:1741-1771,1845-1849`, `src/codex/generation.ts:93-103`). WP9
  consumes the contract-owned `withExpectedConfigGenerationSync`; it does not
  wrap this observer in the lock or redefine the generation contract.
- `src/codex/catalog-admission.ts` (MODIFY) — keep the landed request constructor
  and snapshot capture; switch snapshot capture to the observe-only generation
  read, capture the required PRESENT-or-ABSENT `catalog-target-selection`
  observation, and carry the contract-owned `sourceEvidence`. Do not redefine
  `createCatalogConvergeRequest` or `captureCatalogAdmissionSnapshot`, which
  already exist at lines 32-46 and 84-107.
- `src/codex/convergence-types.ts` (MODIFY) — synchronize the already contract-owned
  closed `CatalogSourceRole`, `CatalogSourceObservation`, `CatalogSourceEvidence`,
  and `CatalogAdmissionSnapshot.sourceEvidence` additions from
  `005_contract.md:792-865`; no WP9-private duplicate type is allowed.
- `src/codex/catalog/filesystem-evidence.ts` (NEW) — sole owner of gather source
  reads and target probes. Its opaque session records PRESENT and ABSENT
  observations before returning, seals the complete closed role map into the
  candidate, and is the only gather path permitted to call filesystem consultation
  primitives (`005_contract.md:895-918`).
- `src/codex/runtime.ts`, `src/codex/catalog/bundled.ts` (MODIFY) — catalog gather
  uses a gather-specific observe-only pair:
  `peekCodexRuntimeForCatalogGather(evidenceSession)` and
  `resolveCatalogSourceForGather(evidenceSession)`. They never probe an executable
  or start a subprocess. The first returns only an already-resolved process-local or
  persisted runtime observation; the second consumes a matching in-memory bundled
  catalog or observed persisted catalog/backup/cache source and otherwise returns
  `catalog-unavailable`. `bundled.ts` owns the catalog-specific adapter;
  `runtime.ts` exposes only a process-cache peek and pure persisted-state parser and
  never imports the catalog evidence module. A cold miss never becomes permission to
  execute Codex.
  The ordinary resolver reaches `probeVersion`, whose sandbox deliberately calls
  `mkdtempSync` and `rmSync` (`src/codex/runtime.ts:231-279,327-340,397-405`), while
  bundled loading both calls the persisting resolver and runs `codex debug models`
  (`src/codex/catalog/bundled.ts:127-169,170-210`). Neither path is reachable from
  gather.
- `src/oauth/index.ts`, `src/oauth/store.ts`,
  `src/codex/catalog/provider-fetch.ts` (MODIFY) — add and consume an observe-only
  active-token snapshot. The filesystem-evidence owner reads the exact auth-store
  buffer under `provider-auth-selection`; `oauth/store.ts` exposes/reuses pure
  normalization semantics rather than calling `peekAuthStore` or another hidden
  filesystem reader. `peekAuthStore` confirms the desired no-chmod/no-backup behavior
  but still owns its own `existsSync`/`readFileSync` consultation today
  (`src/oauth/store.ts:145-157`). The gather path never refreshes, persists, acquires
  an intent lock, creates/removes an intent file, hardens a path, or backs up malformed
  credentials. The current token resolver can enter refresh/persistence
  (`src/oauth/index.ts:281-339,352-354`) and the current gather awaits it
  (`src/codex/catalog/provider-fetch.ts:410-428`).
- `src/codex/refresh.ts`, `src/codex/catalog/sync.ts`,
  `src/codex/catalog/parsing.ts` (MODIFY) — prepare immutable catalog/cache/backup
  bytes and source evidence without writing. In particular, target selection no
  longer hides an `existsSync`/`readFileSync` consultation inside
  `readCodexCatalogPath()` (`src/codex/catalog/parsing.ts:167-176`); admission makes
  that consultation through the evidence owner.

IN — fixed commit and convergence:

- `src/codex/internal/catalog-writer.ts` (NEW/MOVE) — the contract-owned low-level
  owner for catalog, hashed/legacy backups, and models cache. Do not create the
  obsolete `internal/catalog-commit.ts` name
  (`005_contract.md:1172,1178-1179`).
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
- WP11 native lock acquisition. WP9 makes commit synchronous and uses only the
  existing config mutation transaction to exclude cooperating config writers through
  publication; it does not import a future native lock or claim exclusion against
  native/catalog hand edits and foreign writers.
- WP12 full admission/observer/provenance, full `scope:"full"` convergence,
  `/api/sync`, startup, CLI cache sync, restore, and complete writer reachability.
- Any runtime command that starts, stops, syncs, restores, ensures, or manages the
  live service; any write to real `~/.codex` or `~/.opencodex`; GUI/release/deploy.

WP9 typechecks at its own commit. `management-convergence.ts` contains working
catalog behavior, not a placeholder waiting for WP12. WP12 may consolidate the
management factory/projection into `convergence.ts` when it installs the full
entry point; that later move is a module consolidation, not completion of an
unfinished WP9 branch.

Phase-entry gate: the audited source currently exports `readConfigGeneration` and
`bumpConfigGeneration` only (`src/config.ts:1845-1859`); the amended contract assigns
the executable `withExpectedConfigGenerationSync` owner seam to WP8b
(`005_contract.md:615-645`). WP9 implementation starts after that prior phase lands.
If the seam is still absent, stop and report the WP8b scope dependency; do not emulate
it with a second connection, weaken the guard to observe-before-write, or leave a
placeholder for WP12.

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
ownership registration, backup, transient temp-file creation, executable probe, or
subprocess. The guarantee covers scratch outside the Codex/OpenCodex homes too;
there is no permitted gather scratch scope.

This bound deliberately catches the writes hidden by the old plan:

- runtime selection must not persist `codex-runtime.json`;
- ordinary auth reads must not call `loadAuthStoreInternal`, whose read path
  hardens files and backs up invalid JSON (`src/oauth/store.ts:128-137`);
- expired OAuth is a sanitized provider-auth degradation/failure for this gather,
  not permission to refresh and persist;
- admission must not invoke the create-on-read generation path, which can also
  register ownership metadata (`src/lib/config-ownership.ts:202-226,262-282`).
- `resolveCodexRuntime()` is forbidden even though it does not itself persist: a
  cold resolution reaches `probeVersion()`, and that probe intentionally creates
  and deletes a temporary `CODEX_HOME` because real Codex writes even for
  `--version` (`src/codex/runtime.ts:231-279,327-340,397-405`). A final-state
  manifest cannot see that created-then-deleted directory.
- `loadBundledCodexCatalog()` and `runCodexDebugModels()` are forbidden beneath
  gather. The current bundled loader resolves/persists a runtime and executes
  `codex debug models --bundled` without an isolated gather environment
  (`src/codex/catalog/bundled.ts:127-169,170-210`).

The observe-only generation API opens an existing database with `readonly:true`,
performs only schema/version/select checks, and closes it. Missing DB/table/row,
busy, malformed, or unreadable state returns the existing typed unavailable result;
it never initializes generation zero. `captureCatalogAdmissionSnapshot` projects
that result into a typed catalog refusal through the total adapter.

The gather-specific resolver is a separate API, not a flag on
`resolveCodexRuntime()`. `bundled.ts` owns
`peekCodexRuntimeForCatalogGather(evidenceSession)`: it may consume an unexpired
successful value from a pure process-cache peek exported by `runtime.ts`, or parse
persisted `codex-runtime.json` bytes supplied by the evidence session through a pure
runtime-state parser. `runtime.ts` never imports the catalog evidence owner. This
path does not test whether the command is executable, discover PATH alternatives,
call `probeVersion`, persist selection, or execute the command. The observation can
only identify a matching already-populated in-memory bundled-catalog cache; it is not
authority to refill it. `resolveCatalogSourceForGather(evidenceSession)` then tries
that immutable cache value followed by active-catalog/backup/models-cache buffers
read through the evidence owner. Its closed result is usable prepared source or
`catalog-unavailable`; the latter projects to the existing sanitized
`skipped/catalog-unavailable` disposition and leaves no residue.

The observe-only token snapshot receives the exact auth-store buffer from the
filesystem-evidence owner and applies the store's pure normalization once. A
non-expired access token may be used. Missing, malformed, near-expiry, or expired
OAuth credentials yield provider-auth without calling any refresh path. Static API
keys and request headers already present in the admitted `Readonly<OcxConfig>` remain
usable. If the auth-store buffer influences a live provider result, its PRESENT or
ABSENT `provider-auth-selection` observation joins the candidate's private source
evidence; token bytes never do.

### A2 — seal the closed role-bearing source observations

`captureCatalogAdmissionSnapshot(config)` remains the pre-gather constructor. Its
source evidence starts with every conditional role key present as an empty list and
the required `catalog-target-selection` observation for the logical
`$CODEX_HOME/config.toml` path, recorded PRESENT or ABSENT. The opaque
filesystem-evidence session then records every consulted filesystem source under
the contract's closed role union: bundled template, active merge, hashed/legacy
fallback, models-cache fallback, runtime selection, or provider-auth selection
(`005_contract.md:792-852,895-918`). Callers cannot append, omit, remove, or rebuild
those observations.

The required ABSENT state closes a target-selection hole that a present-file digest
list cannot represent. `readCodexCatalogPath()` chooses the default catalog exactly
when `config.toml` is absent (`src/codex/catalog/parsing.ts:167-176`). If that file
appears after gather with `model_catalog_json` selecting another target, no digest of
any previously present file changes; without the required absence observation the
obsolete default target could be overwritten and reported `committed`. Therefore
`config.toml` is always observed with role `catalog-target-selection`, and either
PRESENT -> ABSENT or ABSENT -> PRESENT is `stale` before any write.

For a PRESENT source, the evidence owner reads once and hashes the **same exact
buffer** it returns. For an ABSENT source, it records the logical path, canonical
missing-leaf path, stable canonical-parent identity, and `fileIdentity:null`.
Alternatives consulted and found absent are still evidence because their absence
caused fallback. Process-local caches and network responses are not fabricated as
filesystem observations. The candidate receives a sealed immutable
`CatalogSourceEvidence`; a missing required role or conditional key is structurally
invalid and cannot reach commit.

Immediately before the first replacement, the under-lock commit callback
re-observes every candidate-bound source and compares state, logical/canonical path,
parent identity, file identity, and PRESENT digest. State, identity, path, or digest
drift returns `stale`; unreadable, unresolvable, non-regular, or ambiguous evidence
returns `refused`. Both paths write zero bytes. This detects the audited same-inode
truncate/rewrite even when config generation and target identity are unchanged. It
catches single-direction drift only: content/state A→B→A returning identical
evidence before comparison, parent A→B→A between checks, and a write after the final
comparison remain outside C17 (`005_contract.md:731-762`).

### A3 — preserve bundled-first template precedence

`loadCatalogForSync` keeps its current default-path branch: obtain the bundled
catalog first and clone it as the native template; read the on-disk catalog
separately as the merge source. The invariant is explicit at
`structure/03_catalog-and-subagents.md:23-27` and implemented at
`src/codex/catalog/bundled.ts:225-234` plus
`src/codex/catalog/sync.ts:517-523`.

The WP9 edit removes the materializing fallback call from the tail of
`loadCatalogForSync`; it does not move catalog/backup/cache ahead of an already
available matching bundled template. Gather may clone a matching in-memory bundled
catalog but may not refill that cache. A cold cache falls through to filesystem
sources observed by the evidence owner; no usable native template yields
`catalog-unavailable`. Existing explicit materialization and probing callers remain
outside the 16 management paths until their owning phase migrates them.

### A4 — candidate ownership

The candidate remains opaque, one-shot, and catalog-private. Its `WeakMap` state
contains prepared bytes, result/notices, target identities, the admitted config
generation, and the sealed candidate-bound `CatalogSourceEvidence`. Commit marks it
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
  | { readonly kind: "stale"; readonly reason: "generation" | "source-observation" | "target-identity" | "candidate-consumed" }
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

1. mark the candidate consumed, then call
   `withExpectedConfigGenerationSync(candidate.generation, commitCallback)`;
2. inside the already-held config transaction, validate every target identity and
   re-observe every sealed PRESENT/ABSENT source observation immediately before the
   first write;
3. publish the keyed backup with atomic no-clobber semantics;
4. publish the legacy backup with atomic no-clobber semantics when the default path
   requests it;
5. replace the active catalog;
6. replace the models cache; then return from the synchronous callback so the owner
   can release the config transaction.

The owner-side guard is not a read-before-write check. Its implementation validates
the expected generation using the `configMutationDatabase` handle whose SQLite
transaction is already held, invokes the complete synchronous catalog callback on a
match, and releases only after the callback returns
(`005_contract.md:629-645,692-703`). A cooperating config writer therefore cannot
commit N+1 between validation and catalog publication. Conflict never invokes the
callback; lock/database unavailability projects through the total adapter.

Do not wrap `readConfigGeneration`, `readConfigGenerationAtPath`, or the new
observe-only reader inside `withConfigMutationLockSync`. Those observers open a
second SQLite connection; while the first connection owns `BEGIN IMMEDIATE`, the
second connection contends with its own caller instead of validating it. The guard
must use `readConfigGenerationInTransaction` or its private equivalent on the
already-held database. WP9 consumes the existing config mutation lock only; it does
not import WP11's native lock, and catalog-only work does not bump config generation.

Receipt fields change only after the corresponding replacement succeeds. A failure
returns the exact prefix receipt and consumes the candidate; callers must regather.
There is no rollback claim.

Target identity remains strict except for one create-once rule. Backup publication
creates and hardens a unique adjacent temp, then uses an operation whose contract is
destination-must-not-exist: exclusive hard link or a platform
rename-without-replace equivalent. Ordinary overwrite rename is never a fallback.
The existing `atomicWriteFile` cannot implement this contract because its final
operation is an overwriting rename (`src/config.ts:188-220`, especially line 209).
The unpublished temp is scrubbed and removed on every path.

If publication returns `EEXIST`, another process won after validation. Commit
resolves and validates that winner under stable parent/file identity. A readable,
regular, non-routed valid catalog backup is preserved and the receipt becomes
`preserved`; malformed, unreadable, routed, symlinked, or identity-ambiguous content
is `refused`. The loser never unlinks, truncates, or overwrites the winner. This
exception applies only to a backup create-once target, never to a backup selected as
a gather source; selected source observations remain strict
(`005_contract.md:764-784`).

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
awaits the write-free gather, enters `withExpectedConfigGenerationSync`, executes the
synchronous catalog callback before that owner releases, and projects the result. The
lower-level orchestration lives in new `convergence.ts`, so only that module reaches
`internal/catalog-writer.ts`; the retained management module remains the factory
boundary until WP12 consolidates the full funnel.

### C2 — owner-held config generation, source observations, and target identity only

A `scope:"catalog"` commit does not request `CommitExpectation`, open
`transition-state.ts`, call `beginCodexTransition`, call `assertPublished`, or read
or advance `{nativeGeneration,currentTxId}`. Its `catalog-only` outcome correctly
has no pair fields (`src/codex/convergence-types.ts:207-224`).

Catalog staleness is guarded by:

- the observe-only config generation captured before gather and validated by
  `withExpectedConfigGenerationSync` on its already-held transaction through the
  complete synchronous commit;
- candidate-bound closed PRESENT/ABSENT source observations, including required
  `config.toml` target selection;
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
| generation, source-observation, or identity drift | `skipped/stale`, retryable |
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
| management `POST /api/sync` | `src/server/management/config-routes.ts:261-268` → `src/codex/sync.ts:83-89` → `src/codex/refresh.ts:44-51` | rewire to full convergence and `toSyncResponse` |
| server startup cache invalidation | `src/server/index.ts:403` → `invalidateCodexModelsCache` | route startup through full convergence/observer |
| `ocx sync-cache` | `src/cli/index.ts:849-855` → `invalidateCodexModelsCache` | route CLI command through full convergence |
| native restore | `src/codex/inject.ts:764-774` → `restoreCodexCatalog` → `src/codex/catalog/sync.ts:572-597` | move restore writes behind full convergence/provenance |

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
`OPENCODEX_HOME`, `CODEX_HOME`, any config/runtime home, and a dedicated process temp
root wired through `TMPDIR`, `TMP`, and `TEMP`. Before admission, capture a recursive
manifest of every isolated root: relative path, kind, regular-file SHA-256, size,
mode, nanosecond mtime where available, and symlink target. Compare it after gather.

Start recursive filesystem event journals for every isolated root **before calling
`captureCatalogAdmissionSnapshot`** and stop them only after gather settles. Fail on
create/delete/rename/write/metadata events so a temp file created and deleted within
the interval is visible; the before/after manifest is corroboration, not the only
proof. Prove the harness is non-vacuous with controls that (a) chmod an existing file
and (b) create then delete a temp file; both must fail. Inject throw-on-call executable
hooks for `mkdtempSync`, runtime probing, `execFileSync`/subprocess launch, runtime
persistence, OAuth refresh/persist/intent, ownership registration, generation
initialization, backup creation, and atomic replacement. Reset and separately assert
the permitted process-local caches changed only within their bounded owners.

Broken mutations that must turn T1 red: call `resolveCodexRuntime` on a cold cache,
call `runCodexDebugModels`/`loadBundledCodexCatalog`, replace observe-only runtime
resolution with `resolveAndPersistCodexRuntime`, use `loadAuthStore`, or use
`readConfigGeneration`. The executable spy or pre-admission event journal detects the
subprocess, created-then-deleted probe home, mkdir, chmod, backup, SQLite, ownership,
or other transient write.

### T2 — closed observations, owner-held generation, and identity reject before write

Table-drive every `CatalogSourceRole`: required config target selection,
filesystem-backed bundled-template source, active catalog, selected hashed backup,
selected legacy backup, models-cache fallback, runtime-state source, auth-store source,
and every consulted absent alternative. Gather at config generation N, truncate and
rewrite a PRESENT selected source **in place** so file identity and generation remain
the same, then commit. Expect `stale` and byte-identical targets. Repeat PRESENT ->
ABSENT and ABSENT -> PRESENT. In the required target-selection case, gather with
`config.toml` absent, then create it with `model_catalog_json` selecting another
catalog; expect `stale` and byte-identical old/new targets. Make each re-observation
unreadable/ambiguous and expect `refused` with zero writes. Retarget one parent and
expect target-identity rejection. Compile fixtures that omit
`required["catalog-target-selection"]` or any conditional role key; each must fail,
while the complete shape compiles.

Prove the cooperating-writer guarantee with two real processes and the real config
mutation API. Process A enters
`withExpectedConfigGenerationSync({value:N}, callback)`; callback entry proves
validation matched and pauses while the config transaction is still held. Process B
then attempts a real persisted config mutation. Because the existing lock is
fail-fast (`src/config.ts:1778-1815`), B's first attempt must report lock/busy and must
not commit N+1 while A is paused. A's synchronous catalog bytes land before callback
return; after A releases, B retries through the real mutation API and commits N+1.
Conflict never invokes the callback. Instrument SQLite connection creation and
require the guard to validate through the already-held handle, with no second
connection.

Document but do not claim detection for content A→B→A returning exact A before the
comparison, parent A→B→A entirely between checks, or a write after the comparison.

Broken mutations that must turn T2 red: omit the required ABSENT config observation,
remove digest comparison while retaining generation/file identity, release the config
transaction before callback, or call `readConfigGenerationAtPath` from inside the
guard. The absent->present target switch commits obsolete bytes, the same-inode
rewrite commits stale bytes, process B commits N+1 while A is paused, or the guard
self-contends/opens the forbidden second handle.

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

The ordinary absent→present setup above remains useful but is not the no-clobber race
proof: it creates the backup before commit and would pass a broken
check-absent-then-overwriting-rename implementation. Add a publication barrier after
target/source validation and immediately before the exclusive publish operation.
While process A's hardened temp waits at that barrier, process B atomically creates
the destination and signals A to continue. A must receive `EEXIST`, validate and
preserve B's exact bytes, report `preserved`, and never call ordinary rename or
`atomicWriteFile`. Race two valid publishers from ABSENT and require exactly one
winner. Repeat the interleaving with malformed, unreadable, routed, symlinked, and
identity-ambiguous winners; A refuses without changing winner bytes and always
scrubs its unpublished temp.

Broken mutations that must turn T3 red: set a receipt bit before replacement, catch a
failed replacement and continue, or replace exclusive publication with
check-absent-then-`atomicWriteFile`. Receipt/bytes diverge in a prefix row, or process
A overwrites process B's after-validation winner instead of preserving it.

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
legacy writer rows and reject aliases, re-exports, wrappers, or dynamic imports from
any new root. The same symbol-resolved graph inventories gather filesystem
consultations: every `readFileSync`, `Bun.file`, `existsSync` branch, target
`lstat`/`stat`/`realpath`, or wrapper that reaches one must terminate at
`catalog/filesystem-evidence.ts`. Unresolved/computed edges fail closed.

Broken mutations that must turn T5 red: add a static top-level management-convergence
import, alias a catalog writer into a management route, replace a literal import with
a computed dynamic import, or add an absence-only `existsSync`/target `realpath`
outside the evidence owner. The sentinel or fail-closed graph must reject each.

### T6 — precedence and native-pair exclusion

On the default catalog path, pre-populate the process-local bundled cache with a
template that differs visibly from catalog/backup/cache plus an on-disk
routed/user-native row. Gather must use cached bundled native template fields and
preserve the on-disk merge row without probing or launching Codex. Repeat cold: no
bundled cache plus a valid observed disk fallback succeeds without subprocess; no
bundled cache and no valid disk fallback returns `catalog-unavailable`. Assert no
materialized fallback write. Snapshot the transition row before and after committed,
stale, refused, and failed catalog-only attempts; it must be byte/field identical and
no history schedule appears. Routing artifact and executable-probe spies stay zero.

Broken mutations that must turn T6 red: move disk fallbacks ahead of a populated
bundled cache, call `loadBundledCodexCatalog` to refill a cold cache, request
`CommitExpectation`, or call a routing writer. Template/cold-miss assertions,
executable spies, transition-row equality, or routing spies fail.

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

T1 proves admission/gather launches no runtime probe or subprocess. Any unrelated
runtime fixture retained by the broader suites uses temporary homes and child
processes only. No verification invokes `ocx start`, `stop`, `sync`, `restore`,
`ensure`, any `ocx service` command, or the live proxy on port 10100.

## Accept criteria

| Criterion | Proof | Concrete broken mutation that makes it red |
|---|---|---|
| **C1** — gather is filesystem-write-free across user homes and scratch, performs no executable probe/subprocess, and commit is synchronous, fixed, one-shot, and receipt-exact | T1 + T3 | call cold `resolveCodexRuntime`/`loadBundledCodexCatalog`, add an `await` beneath commit, reorder replacements, pre-set a receipt bit, or replay a consumed candidate |
| **C2/C17** — the owner-held config generation, every closed PRESENT/ABSENT source observation, and target identity reject stale work before write; create-once backups publish atomically without clobber | T2 + T3 | omit ABSENT `config.toml`, release the transaction before callback, remove same-inode digest comparison, open a second SQLite observer, or replace exclusive publication with overwriting rename |
| **Catalog/native boundary** — catalog-only never reads/advances the native pair or writes routing/history artifacts | T6 | call `expectation()`/`beginTransition`, add pair fields to `catalog-only`, or invoke config/profile/journal/history writer |
| **Best-effort compatibility** — all 16 primary writes retain 2xx/201 and original follow-up order for every catalog failure | T4 | let lazy import/factory/admission throw, scope “zero writes” to the whole route, or return before Claude/Desktop follow-up |
| **C14, WP9-bounded** — the 16 management roots reach catalog writers only through convergence; exactly four documented legacy roots remain until WP12 | T5 symbol graph | add a fifth root, hide one through alias/re-export/computed import, or accidentally require WP12 to have already removed `/api/sync`/startup/CLI/restore |
| **N2** — WP9 replaces the landed placeholder, consumes existing request/snapshot/projection seams, creates the contract test, and typechecks without WP10-WP12 | focused tests + typecheck | redefine a WP8b type/helper, refer to a nonexistent later helper, leave a throwing placeholder, or claim the absent test file is merely extended |
