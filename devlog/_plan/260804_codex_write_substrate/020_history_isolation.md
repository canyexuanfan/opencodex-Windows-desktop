# WP10 — history isolation: one client turning off cannot freeze every client

Research: `002_history_off_the_loop.md`. Shared contract: `005_contract.md`.

Today every history mutation is synchronous on its caller. Apply opens
`state_5.sqlite`, writes the manifest and rollouts, then commits the DB transaction
(`src/codex/history-provider.ts:585-653`). Restore reads the manifest, writes
rollouts, commits the DB, removes the manifest, and then performs the residual
ejection (`src/codex/history-provider.ts:656-698`). SQLite serializes only the DB
portion; it does not serialize the manifest and rollout files around it.

The path is also not one operation. `injectCodexConfig` deliberately does nothing
when `syncResumeHistory === false`, forward-tags history to `opencodex` only in
legacy mode, and otherwise migrates history back to `openai`
(`src/codex/inject.ts:602-604`). Native restore invokes the manifest-consuming
`openai` restore/eject path (`src/codex/inject.ts:765-800`), while
`ocx recover-history --legacy-openai` invokes the manifest-independent legacy ejection
(`src/cli/index.ts:711-724`). A Worker request containing only a caller-selected
provider cannot preserve those distinctions.

This plan was previously based on a false landing premise. WP9 did **not** supply a
working full `convergeCodex`: the executable export is catalog-only
(`src/codex/convergence.ts:421-440`), management rejects every non-catalog request
(`src/codex/management-convergence.ts:89-106`), and full admission remains only the
`AdmissionSnapshot` type (`src/codex/convergence-types.ts:495-520`). Native apply and
restore still execute directly (`src/codex/inject.ts:482-654,765-800`). WP10 therefore
cannot consume a full authority snapshot, native receipt, or `CommitExpectation`
without implementing WP11/WP12 work.

## Phase boundary — history isolation now, full convergence in WP12

WP10 takes the reviewer's second option.

Every **current high-level history operation** enters `history-job` and H in this
phase. Existing apply, restore, explicit recovery, startup retry, CLI, service, and
management roots keep their current native/catalog orchestration, but none may call a
history DB/manifest/rollout writer inline. WP10 persists the contract-owned typed
`CodexHistoryOperation`, dispatches its identity to the Worker, and records its result.

The desired-state-driven `convergeCodex({ scope: "full" })` caller rewire is deferred
to WP12. WP12 changes the producer of the durable history operation after full
admission and native coordination exist; it reuses the same `history-job`, Worker, H,
typed operation, writer split, and terminal-state protocol delivered here. WP10 does
not add a temporary convergence implementation, fake admission snapshot, synthetic
native receipt, or placeholder that a later phase replaces.

This boundary is independently landable: WP10 typechecks while full convergence still
rejects non-catalog requests, and current user-visible high-level operations preserve
their distinct history semantics through the Worker.

All current-code citations in this document were rechecked on 2026-08-05 at
`57c273922bdbd63e1b140811e8a07968928849ba`.

## IN / OUT

IN:

- `src/codex/convergence-types.ts` (MODIFY) — materialize the
  contract-owned `CodexHistoryOperation`, typed manifest-read result, and durable
  history-operation schedule/result shapes from `005_contract.md`; do not define a
  WP10-local provider/direction union.
- `src/codex/user-identity.ts` (MODIFY) — add
  `resolveCodexHistorySerializationDatabasePath` beside the existing N and K
  resolvers. It keys H by effective user, canonical `CODEX_HOME`, and canonical
  state-DB path; consumers append no path segment.
- `src/codex/transition-state.ts` (MODIFY) — persist/read the typed history operation
  and its operation identity, expose the history-specific schedule/claim/terminal CAS
  used by current roots, and retain the operation for guardian restart. This is not a
  producer of native generations or full authority snapshots.
- `src/codex/history-lock.ts` (NEW) — H: one cross-process,
  canonical-`CODEX_HOME`/effective-user keyed SQLite exclusion primitive using the
  contract resolver, finite acquisition, and no stale PID/mtime takeover.
- `src/codex/history-provider.ts` (MODIFY/SPLIT) — retain read/probe behavior and the
  typed manifest parser; remove all DB/manifest/rollout writers and module-global
  execution policy.
- `src/codex/internal/history-writer.ts` (NEW) — the exhaustive implementation of
  every `CodexHistoryOperation`, including manifest-consuming restore and manifest-independent
  legacy ejection. Only `history-worker.ts` may reach it.
- `src/codex/history-worker.ts` (NEW) — acquire H, resolve and validate the durable
  operation through N, mutate all three surfaces, run the typed post-probe, publish the
  terminal CAS, release H, and close.
- `src/codex/history-job.ts` (NEW) — resolve explicit paths/options, schedule the
  typed operation durably as the sole root of the WP10 compatibility/explicit-recovery
  authorizers, spawn/watch/join the Worker, classify IPC/death, and expose one async
  entry point to every current high-level root.
- `src/codex/inject.ts`, `src/codex/sync.ts`,
  `src/codex/history-migration-guardian.ts` (MODIFY) — preserve current native/catalog
  behavior but replace inline history calls with `history-job`; the guardian reads and
  retries the durable operation instead of calling the provider.
- `src/cli/init.ts` (MODIFY) — `ocx init` and its `setup` alias retain the history
  migration currently inherited from `injectCodexConfig`
  (`src/cli/init.ts:194-198`; `src/cli/index.ts:727-732`).
- `src/cli/index.ts`, `src/cli/models.ts`, `src/cli/provider.ts`, `src/cli/v2.ts`,
  `src/service.ts` (MODIFY where async propagation is required) — await the existing
  high-level operation through `history-job`; no command imports a history writer.
- `src/server/management-api.ts`, `src/server/management/config-routes.ts`,
  `src/server/lifecycle.ts` (MODIFY) — await the same high-level operation and join
  live history Workers during drain.
- `src/cli/doctor.ts` (MODIFY) — combine durable history state with a typed live
  read-only probe; unavailable evidence remains unknown.
- `tests/codex-history-provider.test.ts`,
  `tests/codex-transition-state.test.ts`,
  `tests/codex-convergence-contract.test.ts`,
  `tests/history-migration-guardian.test.ts`,
  `tests/codex-sync-api.test.ts`, and `tests/shutdown-drain.test.ts` (MODIFY), plus
  `tests/codex-history-worker.test.ts`,
  `tests/codex-history-worker-responsive.test.ts`,
  `tests/codex-history-process-routing.test.ts` (NEW).

OUT:

- A full `convergeCodex`, `AdmissionSnapshot` capture, desired-state observer,
  provenance authorization, or the WP12 caller rewire.
- Native write exclusion, a native receipt, or a native `CommitExpectation` — WP11.
- Any claim that WP9 handed WP10 a working full funnel. It did not.
- Replacing current native/catalog orchestration. In particular,
  `src/codex/inject.ts:775-780` is WP9's K-serialized catalog restore; it remains a
  catalog operation and is not copied into the history Worker.
- `/api/sync` response-contract redesign; WP10 only preserves the current route while
  moving its inherited history operation off-thread.
- GUI, traversal chunking, release/deploy work, or touching the live proxy on 10100.

## Durable operation, not caller-selected provider

The shared contract's `CodexHistoryOperation` is the only executable direction. It
must distinguish at least these existing semantics without flattening them:

| Durable `CodexHistoryOperation` | Existing evidence | Worker behavior |
|---|---|---|
| `skip` | `syncResumeHistory === false` at `src/codex/inject.ts:602-604` | Enter the job/H validation path, perform no manifest/rollout/history-DB read or write, and record `converged` with null counts because no zero/zero claim is made. |
| `apply-opencodex` | legacy branch at `src/codex/inject.ts:602-604` | Manifest-backed forward-tag to `opencodex`. |
| `migrate-openai` | non-legacy branch at `src/codex/inject.ts:602-604` | Manifest-consuming restore followed by residual ejection to `openai`. |
| `restore-openai` | `src/codex/inject.ts:781-800` | Generic native removal: consume the matching manifest and eject residual routed rows, with the current no-op-probe policy retained. It stays distinct from migration because authorization/retry cause differs. |
| `recover-legacy-openai` | `src/cli/index.ts:711-724` | manifest-independent legacy ejection; it must not read, consume, delete, or replace the backup manifest. |

The operation is DERIVED by the caller-facing convergence path from what it already
admitted, never chosen at the Worker boundary. `history-job` does not decide it: the
module mechanically persists the derived operation through the contract-owned history
scheduling API and receives an opaque durable job identity. A serialized Worker
message accordingly contains no `targetProvider`, no caller-chosen `direction`, and no
`CommitExpectation`.
The Worker request carries the job id, operation, and `CodexHistoryAuthority` copied
from the row, plus structured-clone-safe explicit paths and invocation-local execution
options.

After acquiring H, the Worker reads N and obtains the durable schedule. It executes
only when native pair, job id, operation, and authority are current and well-formed.
The durable value is authoritative: the Worker validates the IPC copy against it and still
dispatches from the durable value. A missing,
superseded, malformed, or mismatched operation produces the typed non-success outcome
and performs no history write. A caller can therefore neither turn generic restore
into manifest-independent recovery nor bypass `syncResumeHistory: false` by choosing a provider.

WP12 later schedules the same type from admitted desired state. That is a caller-root
change, not a history-mechanism replacement.

### Contract bridge for the chosen WP10 boundary

WP10 consumes `AuthorizeCodexCompatibilityHistory` for current `skip`,
`apply-opencodex`, `migrate-openai`, and `restore-openai` roots. It conditionally
publishes job id + typed operation +
`CodexHistoryAuthority { kind: "wp10-compatibility", id }` without advancing or
inventing a native routing generation and without pretending to possess WP12's
`AdmissionSnapshot`. `recover-legacy-openai` uses
`AuthorizeCodexLegacyHistoryRecovery` and
`{ kind: "explicit-legacy-recovery", id }`. WP12 alone uses
`BeginCodexTransition` with `{ kind: "admission-snapshot", id }`.

`history-job.ts` is the sole WP10 compatibility adapter. The existing owning
apply/restore/recovery function derives the semantic operation from its internal
branch after its current native/catalog work; it passes that type to `history-job`,
not a user-controlled provider/direction. CLI, server, `inject.ts`, guardian, and
other helpers never import either transition-state authorizer directly. Compatibility
authority ids are fresh opaque nonces, never config/credential digests and never logs.
WP12 dispatches already-admitted schedules through the same job/Worker code and stops
using only the compatibility-authorization branch.

The Worker claim/terminal CAS matches native pair, job id, operation, and complete
authority. A compatibility authority can never be relabeled as admission authority.
This is one contract row and one terminal protocol, not a WP10-private store.

The graph guard consumes the contract's `wp10-history-isolation` inventory version:
`history-job.ts` may reach only the compatibility and explicit-recovery authorizers,
while `history-worker.ts` may reach only the transition reader/terminal updater plus H
and the history writer. The WP12-final version removes the job authorizer root when
full convergence becomes the producer; it retains the Worker root.

## Worker boundary and explicit process state

The Worker owns the whole mutable unit:

1. apply captured `CODEX_HOME`/`OPENCODEX_HOME` before dynamically importing any
   history module;
2. acquire H from the final path returned by the H resolver;
3. read N and resolve/validate the current durable `CodexHistoryOperation`;
4. perform the typed manifest read only for operations that consume/update the
   manifest; `skip` and `recover-legacy-openai` do not read it;
5. open, query, transact, and close `state_5.sqlite` within the invocation;
6. perform every manifest write/delete and rollout line-one patch/append/fsync;
7. run the final typed DB + manifest post-probe while H remains held;
8. publish the operation-identity-conditioned terminal update through N;
9. release H and close the Worker in `finally`.

Moving only `Database` calls is insufficient: apply writes manifest and rollouts before
its DB transaction (`src/codex/history-provider.ts:606-648`), and restore writes
rollouts, DB, manifest deletion, and residual ejection in sequence
(`src/codex/history-provider.ts:656-695`). Moving only server callers is also
insufficient because CLI/service/management paths currently share the same inline
helpers.

The Worker is a separate process context. The current module binds
`STATE_DB_PATH`/`HISTORY_BACKUP_PATH` at module load
(`src/codex/history-provider.ts:16-22`) and stores busy timeout in mutable module state
(`src/codex/history-provider.ts:31-49`). WP10 replaces both with absolute request paths
resolved before spawn and invocation-local options applied to each DB open. This is
feasible without connection transfer: apply, restore, legacy recovery, and the probe
open and close their DB handles per invocation
(`src/codex/history-provider.ts:585-653,656-698,701-710,757-770`).

The request parser rejects blank operation ids, non-absolute paths, path/identity
mismatch, non-finite or negative numeric options, unknown message variants, and test
checkpoints outside the injected test supervisor. `requestId` rejects stray IPC.
Every crossing value is structured-clone data; no `Database`, function, config object,
or lock capability crosses the boundary.

## H database and the real lock order

H is a sibling database, not N or K. `resolveCodexHistorySerializationDatabasePath`
returns the final database path for effective user plus canonical `CODEX_HOME` plus
canonical state-DB identity; callers append nothing. H uses
`busy_timeout=0` and `BEGIN IMMEDIATE` with bounded async outer acquisition. There is
no PID/mtime stale takeover; process/connection death releases SQLite exclusion.

The previous plan's statement that H and N are never held simultaneously was false.
`readCodexTransitionState` opens a `BEGIN IMMEDIATE` initialization transaction
(`src/codex/transition-state.ts:473-489`), and
`updateCodexHistoryTransition` opens another `BEGIN IMMEDIATE` terminal transaction
(`src/codex/transition-state.ts:521-565`). The Worker invokes both while H protects the
history surfaces. The actual edge is therefore:

```text
current high-level root: N(schedule typed operation) -> release N -> spawn Worker
history Worker:          H -> short N(read/claim) -> release N
                        H -> mutate/probe
                        H -> short N(terminal CAS) -> release N -> release H
```

The checkable order is **H → N**. `N → H` is forbidden: scheduling commits and releases
N before spawn/await. H never enters K or the config-generation lock, and K/config
paths never enter H. The future WP11 native callback never spawns or awaits a Worker
while holding N; WP12 dispatches only after releasing native coordination. A busy N
claim/terminal attempt leaves the durable operation pending, releases H, and retries
later; it never waits indefinitely while retaining H.

The lock-order contract test contains allowed fixtures for `H -> N` claim/terminal
calls and forbidden fixtures for `N -> H`, `K -> H`, `H -> K`, and
config-lock-to-H edges. Reversing the schedule/spawn order to await the Worker while N
is live must turn that test red.

## Typed manifest evidence — absence is not success

The current `readBackup` collapses a missing file, malformed JSON, unsupported shape,
and a manifest for another state DB into an empty manifest
(`src/codex/history-provider.ts:204-217`). The pending probe then initializes
`backupEntries = 0` and suppresses manifest failures
(`src/codex/history-provider.ts:749-755`). Combined with a missing DB returning
`pendingRows = 0` (`src/codex/history-provider.ts:756`), unread evidence can certify a
false zero/zero convergence.

WP10 consumes the contract-owned typed manifest read. The reader must preserve these
distinct states through mutation and post-probe:

| Evidence | Classification | May certify zero entries? |
|---|---|---|
| manifest absent and DB readable | `missing`, `backupEntries: 0` | Yes, only after the DB probe also succeeds. |
| valid present v1 manifest for the requested DB | `ready` with at least one validated entry | Yes. |
| malformed JSON | `malformed`, null count | No. |
| readable unsupported version/shape | `unsupported`, null count | No. |
| unreadable/permission failure | unreadable | No. |
| manifest identifies another state DB | `foreign-state-db`, null count | No. |
| DB missing while a valid backup has entries | pending/blocked restore work | No. |

Only a successful typed DB probe and successful typed manifest read may produce
numeric counts. `unreadable` maps to `unknown/unreadable`, malformed/unsupported maps
to `unknown/schema`, and a foreign manifest maps to
`blocked/foreign-state-db`, all with null manifest count. Generic restore never treats
a foreign-DB manifest as empty and never deletes it; manifest-independent legacy recovery does not
consume the manifest at all.

Fixtures cover malformed JSON, unreadable file, unsupported shape, wrong DB identity,
and missing DB with a nonempty backup. Reintroducing `catch { return emptyManifest }`
or `catch { backupEntries = 0 }` must turn each named fixture red.

## Writer reachability: one permitted production root

`history-provider.ts` currently mixes read exports with mutators: read-only
`readLatestSessionMeta`, `readThreadFieldsFromRollout`, and
`countPendingOpencodexHistory` coexist with `syncCodexHistoryProvider`,
`restoreLegacyOpenaiHistory`, and `migrateHistoryToOpenai`
(`src/codex/history-provider.ts:263-274,348-422,565-579,701-731,749-775`). Split it so
the production graph has one writer root:

```text
history-worker.ts -> history-lock.ts (H)
history-worker.ts -> transition-state.ts (durable operation claim/terminal CAS)
history-worker.ts -> internal/history-writer.ts
internal/history-writer.ts -> manifest writes/deletes
                           -> rollout line-one patch + append + fsync
                           -> history DB transactions
```

No CLI, server, guardian, `inject.ts`, `sync.ts`, compatibility wrapper, barrel,
re-export, or dynamic import may reach `internal/history-writer.ts` or its mutating
symbols. Tests invoke the public job/Worker boundary; focused writer unit fixtures may
import the internal module only from the test allowlist.

The guard is symbol-level, not regex counting. Build a TypeScript `Program` and
`TypeChecker`, resolve import aliases, re-exports, namespace access, and string-literal
dynamic imports, then compute reachability from every production entry symbol to the
writer symbols. The current route-count test merely counts the literal text
`await convergeCodexCatalog()` (`tests/codex-convergence-contract.test.ts:232-250`);
that approach cannot prove this boundary.

The graph fixture includes negative variants that must fail:

- wrapper calls writer, caller imports wrapper;
- barrel re-exports writer under another name;
- aliased named import calls writer;
- namespace import calls writer;
- string-literal dynamic import calls writer;
- new production module reaches writer without appearing in the caller table.

## Current production caller inventory

WP10 rewires the existing high-level operations, not a nonexistent full funnel. The
symbol-level test owns this table as data and proves each listed command/route reaches
`runCodexHistoryJob` when its current semantics request history, never a writer.

| Production command/route | Current history-bearing chain | WP10 terminal edge | Named broken change that must fail |
|---|---|---|---|
| `ocx init`, `ocx setup` | command dispatch -> `runInit` -> `injectCodexConfig` (`src/cli/index.ts:727-732`; `src/cli/init.ts:194-198`) | typed apply operation -> job | Restore direct `injectCodexConfig` history mutation or remove the job await from init. |
| `ocx start` | `handleStart` -> `syncModelsToCodex`; starts guardian (`src/cli/index.ts:318-321`) | apply job + durable guardian retry | Startup stops arming the guardian, or inject runs inline. |
| `ocx ensure` | existing/live and spawned paths call `syncModelsToCodex` (`src/cli/index.ts:358-412`) | apply job | Either ensure branch bypasses/does not await the job. |
| `ocx sync` | command -> `syncModelsToCodex` (`src/cli/index.ts:827-842`) | apply job | Sync calls provider writer directly. |
| `ocx restore back`, `ocx eject back` | command -> `syncModelsToCodex` (`src/cli/index.ts:745-764`) | apply job | Back-switch returns before job dispatch. |
| `ocx restore`, `ocx eject` | command -> `restoreNativeCodex` (`src/cli/index.ts:765-790`) | generic restore job | Restore keeps the current inline `syncCodexHistoryProvider("openai")`. |
| `ocx stop` | `handleStop` -> `restoreNativeCodex` (`src/cli/index.ts:456-551`) | generic restore job | Stop reports completion without awaiting Worker join. |
| `ocx uninstall`, `ocx remove` | `handleUninstall` -> `restoreNativeCodex` (`src/cli/index.ts:554-593,795-798`) | generic restore job | Uninstall invokes synchronous restore wrapper. |
| `ocx restart` | `handleStop` then `handleEnsure` (`src/cli/index.ts:968-973`) | restore job then apply job | Restart overlaps the two jobs or skips either await. |
| hidden `__tray-start`, `__tray-restart` | tray start launches the ordinary start process; restart awaits `handleStop` then tray start (`src/cli/index.ts:415-453,944-954`) | startup apply job; restart restore then apply | Tray restart starts before restore joins, or direct start bypasses ordinary startup. |
| `ocx recover-history --legacy-openai` | `handleRecoverHistory` -> `restoreLegacyOpenaiHistory` (`src/cli/index.ts:711-724,792-794`) | manifest-independent legacy-eject job | Recovery maps to generic restore and consumes manifest. |
| `ocx provider ... --sync` | provider mutation -> `syncModelsToCodex` (`src/cli/provider.ts:232-238`) | apply job | Provider sync imports writer or drops job await. |
| `ocx models/model ...` live sync | model mutation -> `syncModelsToCodex` (`src/cli/models.ts:102-108`) | apply job | Model sync returns after catalog only. |
| `ocx v2 mode/on/off` | dynamic import of `syncModelsToCodex` (`src/cli/v2.ts:143-170,177-196`) | apply job | Dynamic-import alias bypasses the job; this exercises alias/dynamic reachability. |
| `POST /api/sync` | route -> `syncModelsToCodex` (`src/server/management/config-routes.ts:261-268`) | automatic apply job | Route responds while history remains inline or untracked. |
| `POST /api/stop` | route -> `restoreNativeCodex` (`src/server/management-api.ts:220-247`) | automatic generic restore job + drain join | Route schedules process exit before Worker join. |
| `ocx service stop` | service command -> `restoreNativeCodex` (`src/service.ts:2564-2595`) | explicit generic restore job | Service stop calls sync restore. |
| `ocx service start` | service command starts the installed daemon (`src/service.ts:2560-2564`) | daemon's ordinary startup apply job | Service-specific startup bypasses the ordinary startup/guardian root. |
| `ocx service uninstall/remove` | service command -> `restoreNativeCodex` (`src/service.ts:2610-2635`) | explicit generic restore job | Service uninstall drops/does not await job. |
| graceful SIGINT/SIGTERM/SIGHUP shutdown | drain then cleanup (`src/cli/index.ts:277-310`) | cancel/join active job, then await generic restore when policy requires it | Shutdown leaves history inline in `syncCleanup` or exits before join. |
| `process.on("exit")` / forced exit | synchronous callback at `src/cli/index.ts:310` | no history mutation; any existing durable pending operation remains for next startup | Exit hook imports writer or tries to spawn/await a Worker. |
| history guardian retry | timer currently calls provider directly (`src/codex/history-migration-guardian.ts:43-95`) | reread durable operation -> automatic job | Fake-clock test still passes after guardian startup dispatch is removed. |

The table is exhaustive for production references to the current history-bearing
helpers, derived from `injectCodexConfig`, `restoreNativeCodex`,
`syncModelsToCodex`, `restoreLegacyOpenaiHistory`, and
`startHistoryMigrationGuardian`. Adding a new command/route that reaches one of those
symbols without an inventory row fails the inventory test. Adding a direct writer
bypass anywhere fails the graph test even if route counts are unchanged.

## Failure, timeout, retry, and drain

The parent owns one process-local flight per durable operation identity only to avoid
duplicate Worker threads; H provides cross-process exclusion. Same-operation callers
may join. A newer durable operation supersedes an older one: the old Worker either
rejects it at the under-H claim or loses the terminal CAS, releases H, and leaves the
newer operation pending for repair.

Outcome classification remains evidence-bearing:

- H or history DB busy -> `pending/db-busy` with a next retry;
- permission/refusal -> `blocked/permission`;
- unreadable DB/manifest -> `unknown/unreadable`, nullable counts;
- supported read but unsupported schema/shape -> `unknown/schema`, nullable counts;
- watchdog -> `unknown/timeout`;
- graceful cancellation -> `unknown/shutdown-cancelled`, then join;
- Worker error, malformed terminal IPC, or early close -> reread durable state before
  conditionally publishing `unknown/worker-died`;
- superseded identity/terminal CAS conflict -> typed overtaken/superseded result, no
  self-retry of the loser;
- terminal N update failure -> `unknown/record-write-failed`, preserving pending work.

The Worker closes in `finally`; parent cancellation and shutdown await actual thread
exit using the existing join discipline (`src/storage/worker-lifecycle.ts:150-209`).
A watchdog contains one attempt; it never certifies convergence.

Make execution policy invocation-local:

| Caller mode | H / SQLite wait | Attempts / delay | Result |
|---|---:|---:|---|
| automatic (startup, management, guardian, graceful stop) | 100 ms | 1 / 0 ms | Defer durably and keep listener/drain bounded. |
| explicit CLI | 5,000 ms | 2 / 500 ms | Preserve the current operator wait budget inside the Worker. |

The current defaults are a module-global 5,000 ms busy timeout and two attempts with a
500 ms synchronous delay (`src/codex/history-provider.ts:31-49,526-548`). Automatic
mode never calls `sleepSync` on the parent. Explicit delay may occur inside the Worker
while H remains held so another process cannot overtake between attempts.

The guardian uses capped exponential backoff with deterministic injected jitter,
keeps at most one timer/Worker for the current durable operation, and has no finite
lifetime attempt cap. Startup immediately re-arms unresolved durable work. This
replaces the current sixty-tick terminal stop
(`src/codex/history-migration-guardian.ts:34-35,47-48,87-95`).

## Deterministic tests

### Cross-process all-surface serialization

Seed a production-shaped DB, valid manifest, and rollouts under temporary homes.
Process A schedules one real operation and pauses after the first real rollout write
while retaining H. Process B schedules the opposite operation and reaches H. Resume A;
assert its terminal update cannot replace B's newer durable operation, H is released,
and B repairs manifest, rollouts, and DB. Reverse direction/order and repeat. No test
stub mutates a surface; both processes enter production `history-job`/Worker/H.

Broken change: release H after the DB transaction but before manifest/rollout/probe, or
dispatch the writer without H. The sentinels interleave and the test fails.

### H namespace and lock order

Two child processes vary `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_RUNTIME_DIR`, `TEMP`,
`TMP`, and `LOCALAPPDATA` while retaining the same effective uid/SID, canonical
`CODEX_HOME`, and canonical state DB. They must resolve the same H final path. A second
canonical state DB under that home must resolve a different H while N/K remain the
same, and H must equal neither N nor K. Run the allowed `H -> N` and forbidden
`N/K/C -> H` symbol fixtures.

Broken changes: hash the raw request path/environment home, omit state-DB identity,
reuse N/K's database, or introduce an inverse edge. Path-equality/inequality or graph
fixture fails.

### Operation binding

For every `CodexHistoryOperation` variant, schedule it durably, tamper any diagnostic
request copy to a different operation, and assert the Worker either derives the
durable value or rejects before mutation. The manifest-independent recovery fixture keeps the
manifest byte-identical; the generic restore fixture consumes it only after successful
restore.

Broken change: dispatch from request `targetProvider`/direction instead of the durable
operation. The variant and tamper cases fail.

### Manifest truth

Run the malformed, unreadable, unsupported-shape, wrong-DB, and missing-DB-with-backup
fixtures through both the preflight and under-H post-probe. None may return numeric
zero/zero convergence.

Broken change: map any manifest read failure to an empty manifest or initialize an
unknown count to zero. Its named fixture fails.

### Retry, death, and guardian activation

Advance a fake monotonic clock through exponential growth and the cap. Assert startup
arms the guardian from durable unresolved state, every fired attempt goes through
`history-job`, and a later timer remains after retryable failure. Cover Worker error,
malformed terminal IPC, early close, watchdog, cancellation, and terminal-N failure;
assert join exactly once and preserve distinct reasons.

Broken changes: remove the startup guardian call, let guardian call a writer directly,
or stop after a fixed tick count. The activation/reachability/backoff cases fail.

### Responsiveness for every root class

Hold a real `BEGIN IMMEDIATE` on the history DB and overlap health/data-plane traffic
with each root class: `POST /api/sync`, `ocx init/setup` command handler,
graceful shutdown, and explicit legacy recovery. Bind server port `0` and use temporary
homes. Health responses remain 200, the stream completes, command/shutdown deadlines
remain bounded, durable state records non-success, and every Worker joins. Release the
holder and prove a later serialized job succeeds.

Broken changes: run one root's probe/mutation on its caller thread or fail to await its
Worker during drain. The corresponding table row's responsiveness/drain case fails;
one responsive route cannot hide another inline caller.

### Symbol graph and inventory mutation checks

Run every wrapper/alias/re-export/dynamic-import negative graph fixture and every
production command/route inventory row. For each inventory row, mutate its terminal
edge to a direct writer or no history dispatch and prove the test fails before
restoring the fixture.

Broken change: add a seventh route, wrapper, alias, or new command that reaches a
writer outside the inventory. Symbol reachability fails even if regex counts do not
change.

## Verification

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts tests/codex-history-worker.test.ts
bun test tests/codex-transition-state.test.ts tests/history-migration-guardian.test.ts
bun test tests/codex-history-process-routing.test.ts tests/codex-convergence-contract.test.ts
bun test tests/codex-sync-api.test.ts tests/shutdown-drain.test.ts
bun test tests/codex-history-worker-responsive.test.ts --timeout 30000
bun run privacy:scan
bun run test
```

All process tests use `mktemp -d`/temporary homes and port `0`. No command invokes
`ocx start`, `ocx stop`, `ocx sync`, `ocx restore`, `ocx ensure`, or `ocx service *`;
the installed service and live proxy on 10100 remain untouched.

## Accept criteria — each criterion has a red test

| Criterion | Passing evidence | Concrete broken change that turns it red |
|---|---|---|
| **C3 — caller responsiveness** | Table-driven responsiveness covers management, init/setup, graceful shutdown, and explicit recovery while real SQLite contention overlaps health/SSE progress. | Move any listed root's probe or mutation back to the caller thread. That root's latency/progress case fails. |
| **C4 — durable unresolved work** | Guardian activation/backoff test proves unresolved typed operation survives failure/restart and never becomes zero-looking success. | Remove startup arming, restore the 60-tick stop, or persist zero counts after failed evidence. The activation/backoff/evidence case fails. |
| **C15 — cross-process all-surface serialization** | Opposite operations serialize manifest, rollout, DB, post-probe, and terminal update under one H; newer durable operation repairs stale work. | Release H between surfaces or bypass H in one process. The sentinel/final-state case fails. |
| **Operation authority** | Every operation variant is derived/validated from durable state, including no-op and manifest-independent recovery. | Trust request `targetProvider`/direction. Tamper and manifest-preservation cases fail. |
| **Real lock order** | Architecture fixtures allow `H -> N` and reject every inverse/cross-domain edge. | Await/spawn H while N is held, or call K from the Worker. Dependency fixture fails. |
| **One H namespace per canonical history DB** | Environment-divergent child processes resolve one H for the same effective user/home/DB, a different H for a second DB, and paths distinct from N/K. | Key by environment/raw alias, omit DB identity, or reuse N/K. Resolver equality/inequality case fails. |
| **Manifest evidence** | Malformed, unreadable, unsupported, wrong-DB, and missing-DB-with-backup fixtures remain non-converged with nullable unknown counts. | Convert any failed manifest read to empty/zero. Its fixture fails. |
| **No writer bypass** | TypeScript symbol reachability permits only `history-worker.ts` as a production writer root and catches wrappers, aliases, re-exports, namespace and dynamic imports. | Add any direct/indirect production writer path. Graph test fails. |
| **Complete current caller routing** | Inventory covers every production command/route and each history-bearing row reaches `runCodexHistoryJob`; named disconnect mutations are red. | Remove init, guardian, shutdown, service, or any other row's job edge, or add an unlisted caller. Inventory test fails. |
| **N2 — independently landable** | WP10 typechecks and focused/full suites pass while executable convergence remains catalog-only; current operation semantics are preserved through H. | Import/call full `convergeCodex`, require WP11 native lock/receipt, or leave a temporary inline path. Typecheck/routing behavior test fails at the WP10 commit. |
