# WP10 — history isolation: one client turning off cannot freeze every client

Research: `002_history_off_the_loop.md`. Read it first; this doc is the diff.

Today, a server-side native restore enters `syncCodexHistoryProvider("openai")`
on the listener thread before `/api/stop` schedules drain, so a Codex SQLite
writer lock can hold the proxy for roughly 10.5 seconds and a successful
row/rollout traversal has no finite work bound at all
(`src/server/management-api.ts:167-194`, `src/codex/inject.ts:759-794`,
`src/codex/history-provider.ts:526-699`). That is the incident: turning one
client off can stop every other client, which is the exact opposite of the
integration switch's purpose
(`../260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:25-30`). This
phase adds an owned Bun Worker boundary for every history operation executed by
the server process, a fail-fast automatic SQLite mode, and a durable unresolved
history fact. Explicit CLI-process recovery keeps the existing synchronous
budget because blocking its own terminal does not starve the proxy. This phase
does not add the WP11 native-write lock and does not depend on it.

## IN / OUT

IN:

- `src/codex/history-provider.ts` (MODIFY) — make busy timeout and retry mode
  explicit per invocation, and preserve a classified recoverable failure.
- `src/codex/history-convergence.ts` (NEW) — own
  `getConfigDir()/integrations/codex.json`, its schema, fail-closed updates, and
  user-facing history status.
- `src/codex/history-worker.ts` (NEW) — Worker entry point; set the captured
  environment before dynamically importing the history provider.
- `src/codex/history-job.ts` (NEW) — per-state-DB single flight, Worker IPC,
  watchdog, close tracking, and durable state transitions.
- `src/codex/inject.ts` (MODIFY) — await the injected history executor and split
  synchronous CLI restore from asynchronous server restore.
- `src/codex/sync.ts` (MODIFY) — carry an explicit `inline | worker` execution
  choice to injection; default remains CLI-safe `inline`.
- `src/codex/history-migration-guardian.ts` (MODIFY) — schedule the Worker job;
  never call the synchronous probe or mutation on a daemon tick.
- `src/cli/index.ts` (MODIFY) — startup selects `worker`; explicit `sync`,
  `restore`, `eject`, `ensure`, and service-command processes retain `inline`.
- `src/server/management/context.ts` (MODIFY) — add the existing-style sync seam
  needed to drive a real management request deterministically in the liveness
  test (`src/server/management/context.ts:9-50`).
- `src/server/management/config-routes.ts` (MODIFY) — `/api/sync` selects Worker
  execution and `GET /api/codex/history` exposes the durable fact.
- `src/server/management-api.ts` (MODIFY) — `/api/stop` awaits the server-safe
  restore and returns pending/blocked history honestly before scheduling drain.
- `src/server/lifecycle.ts` (MODIFY) — cancel, join, and persist cancellation for
  a history Worker before listener teardown, beside the storage Worker joins
  (`src/server/lifecycle.ts:407-445`).
- `src/cli/doctor.ts` (MODIFY) — combine the live read-only probe with the durable
  reason, attempt time, and next retry (`src/cli/doctor.ts:891-902`).
- `tests/codex-history-provider.test.ts` (MODIFY),
  `tests/history-migration-guardian.test.ts` (MODIFY),
  `tests/codex-sync-api.test.ts` (MODIFY), and
  `tests/shutdown-drain.test.ts` (MODIFY) — pin changed contracts in their
  existing owners.
- `tests/codex-history-worker.test.ts` (NEW),
  `tests/codex-history-convergence.test.ts` (NEW),
  `tests/codex-history-worker-responsive.test.ts` (NEW), and
  `tests/codex-history-process-routing.test.ts` (NEW) — isolate Worker parity,
  durable retry truth, measured server liveness, and process routing.

OUT:

- `gui/**` — this substrate exposes a truthful management status; the switch UI
  belongs to the later Codex-toggle unit (`000_plan.md:20-22`,
  `000_plan.md:62-70`).
- `docs-site/**` — no user-facing switch or configuration key ships in WP10.
  The later toggle phase documents the final control surface.
- `src/codex/history-provider.ts` traversal/chunking — batching does not create a
  finite bound for row count, rollout bytes, file count, or fsync latency; the
  Worker boundary is the availability fix
  (`src/codex/history-provider.ts:581-699`,
  `002_history_off_the_loop.md:474-486`).
- `src/storage/worker-lifecycle.ts` — history has a different resource key and
  job state. Sharing the storage reservation would let a cleanup spawn terminate
  or serialize behind unrelated history work (`src/storage/worker-lifecycle.ts:40-50`,
  `src/storage/worker-lifecycle.ts:123-143`). WP10 copies no storage mutation
  authority; it reuses its close/join discipline in a dedicated controller.
- `src/codex/lock*`, lock files, lock directories, and WP11 protocol — no native
  write lock exists yet. The only lock used here is the already-shipped,
  zero-wait `withConfigMutationLockSync` around the small
  `integrations/codex.json` read-modify-write, not around Codex files, SQLite, or
  Worker execution (`src/config.ts:1767-1808`). If that state write cannot acquire
  immediately, the history mutation is not dispatched.
- History mutation authority — the Worker executes only after its caller's
  current authority checks. WP12 will strengthen that admission; moving code to
  another thread is not permission to write (`002_history_off_the_loop.md:272-276`).
- Subprocess isolation — Bun 1.3.14 is pinned in CI
  (`.github/workflows/ci.yml:220-222`) and the repository already runs synchronous
  SQLite/filesystem work in TypeScript Workers (`src/storage/restore-job.ts:156-234`).
  A subprocess is fallback work only if Worker teardown proves a history-specific
  Bun defect.

## Worker boundary

### Why this is a Worker, and what Bun actually guarantees

Bun Workers run TypeScript/ES modules without a compile step, communicate through
structured-clone `postMessage`, report module-resolution failures through `error`,
and emit `close` when marked terminated. Bun's own documentation also warns that
Worker termination remains experimental and that the thread can take time to
fully exit ([Bun Workers](https://bun.sh/docs/runtime/workers)). The repository has
already converted that warning into a stronger local rule: attach `close` at spawn,
do not treat `terminate()` as a join, and wait an OS-settle window on Windows and
macOS (`src/storage/worker-lifecycle.ts:1-17`,
`src/storage/worker-lifecycle.ts:150-209`). WP10 follows that local rule.

The Worker runs the whole history unit, not merely the contended statement:

1. optional read-only no-op probe;
2. SQLite open, queries, transactions, and close;
3. backup-manifest read/write;
4. every rollout read, line-one patch, append, and fsync;
5. the final read-only pending probe for an `openai` restore.

Moving only `Database` calls is insufficient because full JSONL reads, per-file
patches/appends, and fsync are also synchronous and unbounded
(`src/codex/history-provider.ts:67-79`,
`src/codex/history-provider.ts:102-157`,
`src/codex/history-provider.ts:258-274`,
`src/codex/history-provider.ts:581-699`).

### Serializable request and response

`src/codex/history-worker.ts` accepts one plain-data message:

```ts
export interface HistoryWorkerRequest {
  type: "run";
  requestId: string;
  targetProvider: "openai" | "opencodex";
  stateDbPath: string;
  backupPath: string;
  busyTimeoutMs: number;
  attempts: number;
  delayMs: number;
  skipWhenProvablyNoop: boolean;
  env: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}

export type HistoryWorkerResponse =
  | {
      type: "done";
      requestId: string;
      result: CodexHistorySyncResult;
      postProbe: PendingHistoryCount | null;
    }
  | {
      type: "error";
      requestId: string;
      reason: "permission_denied" | "state_unreadable" | "worker_error";
    };
```

Every crossing value is a string, finite number, null, or plain object containing
those values. No `Database`, `Error`, callback, config object, file handle, or
class instance crosses structured clone. The parent resolves `stateDbPath` and
`backupPath` before spawn. The Worker applies the captured homes and only then
dynamically imports `history-provider.ts`; this avoids the current module-level
`CODEX_HOME` binding selecting a parent test's stale home
(`src/codex/history-provider.ts:16-22`, `src/codex/paths.ts:6-29`). The repository's
storage Worker records the same environment caveat
(`src/storage/restore-worker.ts:16-40`).

The parent accepts a message only when `requestId` matches and the payload passes a
shape guard. `done` is not automatically `converged`: for target `openai`,
`postProbe` must be non-failed with both `pendingRows === 0` and
`backupEntries === 0` (`src/codex/history-provider.ts:734-775`). A provider result
with `failed: true`, a malformed message, or a failed/nonnull post-probe is durable
unresolved state.

### Failure, timeout, and death

**INFERRED design decision:** `src/codex/history-job.ts` owns one active
operation per normalized state-DB id.
Same-target callers join the same Promise; an opposite-target caller gets
`history_operation_busy` and does not overwrite the active attempt. This is an
in-process single flight, not the WP11 cross-process native-write lock.

The parent resolves outcomes in this order:

- valid `done` message → classify from mutation result and post-probe;
- valid `error` message → `blocked` with the Worker-provided safe reason;
- `worker.onerror` → `unknown / worker_error`;
- `close` before a valid terminal message → `unknown / worker_died`;
- 10-minute watchdog → terminate and join, then `pending / worker_timeout`;
- shutdown cancellation → terminate and join, then
  `pending / shutdown_cancelled`.

A `done` result with `failureReason: "sqlite_busy"` becomes retryable
`pending / sqlite_busy`; permission becomes `blocked / permission_denied`; a
failed or structurally unknown post-probe becomes `unknown / state_unreadable`.
Only the clean zero/zero post-probe reaches `converged` for target `openai`.

**INFERRED containment decision:** ten minutes matches the existing storage restore watchdog
(`src/storage/restore-job.ts:40-46`, `src/storage/restore-job.ts:190-215`). It is a
containment deadline, not a claim that history finishes in ten minutes. Because
the work has no finite bound, timeout can interrupt a legitimate large history;
the pre-dispatch durable `pending` fact therefore remains authoritative, the next
startup retries, and the explicit CLI command remains the unbounded operator path.
The Worker closes itself in `finally`; the parent still calls its join helper on
every terminal path, because Bun `close` does not prove immediate OS thread reclaim
(`src/storage/restore-worker.ts:43-55`,
`src/storage/worker-lifecycle.ts:176-199`).

## Fail-fast automatic mode

The current writable connection reads one mutable global
`historyDbBusyTimeoutMs = 5000`, and `withHistoryRetry` defaults to two attempts
with `Bun.sleepSync(500)` between them
(`src/codex/history-provider.ts:25-49`,
`src/codex/history-provider.ts:526-548`). WP10 makes the policy explicit:

| Caller | Execution | SQLite busy timeout | Attempts / delay | Reason |
|---|---|---:|---:|---|
| Server startup, `/api/sync`, `/api/stop`, guardian, future toggle | Worker | **100 ms** | **1 / 0 ms** | Automatic convergence must release the history slot quickly when Codex owns SQLite. The read-only probe already uses 100 ms (`src/codex/history-provider.ts:749-774`). |
| Explicit CLI `restore`, `eject`, `recover-history`, `sync`, `restore back`, `ensure` parent | CLI process, inline | **5,000 ms** | **2 / 500 ms** | The invoking terminal may wait for a transient Codex lock; this preserves today's operator behavior (`src/codex/history-provider.ts:25-49`, `src/codex/history-provider.ts:526-548`). |

Automatic mode does not call `sleepSync`; its scheduler delay is the retry. The
100 ms budget bounds only lock waiting. It does not and cannot bound a successful
row/file walk; that is why fail-fast without Worker isolation failed the research
gate (`002_history_off_the_loop.md:183-205`).

## Unresolved history is a durable fact

### Location and exact shape

**INFERRED schema decision:** the record is
`join(getConfigDir(), "integrations", "codex.json")`, beneath
`OPENCODEX_HOME`, never `CODEX_HOME`. This reuses the repository's owned
integration directory and atomic-write convention
(`src/integrations/ownership.ts:60-71`,
`src/integrations/ownership.ts:94-106`). It is the one future Codex integration
record, not a second history-only file. WP10 writes `version` and `history`; WP12
may add desired state and the artifact ledger without moving history.

```json
{
  "version": 1,
  "history": {
    "<16-hex normalized state DB id>": {
      "stateDbPath": "/absolute/CODEX_HOME/state_5.sqlite",
      "backupPath": "/absolute/OPENCODEX_HOME/codex-history-backup-<id>.json",
      "targetProvider": "openai",
      "state": "pending",
      "reason": "sqlite_busy",
      "attemptId": "uuid",
      "attemptCount": 3,
      "lastAttemptAt": "2026-08-04T00:00:00.000Z",
      "pendingRows": null,
      "backupEntries": 4,
      "automaticRetry": true,
      "nextRetryAt": "2026-08-04T00:01:00.000Z"
    }
  }
}
```

`state` is `pending | running | blocked | converged | unknown`. `reason` is null
only for `converged`; otherwise it is one of `sqlite_busy`, `permission_denied`,
`state_unreadable`, `state_write_busy`, `history_operation_busy`, `worker_error`,
`worker_died`, `worker_timeout`, or `shutdown_cancelled`. Counts are nullable:
failed probes mean unknown, never numeric zero. The key uses the same normalized
state-DB hash already used for backup naming
(`src/codex/history-provider.ts:16-22`).

Before spawn, the parent writes `pending` with a new `attemptId`. After creating an
idle Worker but before posting `run`, it writes `running`. Both updates use the
already-shipped zero-wait config mutation transaction only around read/merge/atomic
write (`src/config.ts:1767-1808`). If either write is busy or fails, the Worker is
not messaged and no history mutation starts. A terminal update applies only when
the stored `attemptId` still matches; an older in-process completion cannot turn a
newer attempt green. If the final state write fails after mutation, the record
stays `running` or `pending`, which is a retryable false negative rather than a
false success.

`converged` for target `openai` is legal only after the clean post-probe proves
zero pending rows and zero backup entries. Manifest absence alone is insufficient:
the no-backup ejection path can still have work, and a failed probe currently
returns zero-looking counts with `failed: true`
(`src/codex/history-provider.ts:656-665`,
`src/codex/history-provider.ts:749-775`).

### Retry ownership and user visibility

- A running server retries `pending`, `unknown`, and retryable `blocked` entries
  every 60 seconds, at most 60 ticks per process lifetime. The durable record keeps
  `automaticRetry: true`; after the in-process budget, `nextRetryAt: null` means
  “next proxy startup,” not “abandoned.” This preserves the current finite guardian
  cadence while replacing its event-loop mutation
  (`src/codex/history-migration-guardian.ts:34-40`,
  `src/codex/history-migration-guardian.ts:54-92`).
- Every proxy startup treats persisted `pending`, `running`, `blocked`, or
  `unknown` as retryable. A stale `running` state is not proof a Worker survived
  its process.
- Explicit CLI recovery runs inline with the full budget, then writes the same
  record. It never reports success while the durable entry remains unresolved.

The user sees the fact in three places. `GET /api/codex/history` returns the entry;
`/api/sync` and `/api/stop` include the same status in their response; and
`ocx doctor` prints, for example:

```text
--  Codex resume history unresolved: sqlite_busy
    4 routed thread(s) may remain hidden in native Codex
    automatic retry: 2026-08-04T00:01:00.000Z; run `ocx restore` after closing Codex to retry now
```

The wording says “may remain hidden” when counts are null. OFF/config restoration
and history convergence are separate facts; no `success: true` envelope may erase
the warning. That fixes the current shape where `restoreNativeCodex` returns
`success: cfg.success` while history failure exists only in message text
(`src/codex/inject.ts:783-794`).

## Diff

Line anchors below are against current HEAD `7e67a8d06311de2471b0a25e41cf85f97007cc69`.

### `src/codex/history-provider.ts`

Make writable busy timeout invocation-local while preserving the test override as
the explicit-mode default:

```diff
 let historyDbBusyTimeoutMs = 5000;
+export const AUTOMATIC_HISTORY_DB_BUSY_TIMEOUT_MS = 100;
@@
-function openStateDb(stateDbPath: string): Database {
+function openStateDb(stateDbPath: string, busyTimeoutMs = historyDbBusyTimeoutMs): Database {
   const db = new Database(stateDbPath);
   try {
-    db.exec(`PRAGMA busy_timeout = ${historyDbBusyTimeoutMs}`);
+    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
```

Extend the existing result and options; do not replace `failed`, because current
callers and tests use it (`src/codex/history-provider.ts:160-168`,
`src/codex/history-provider.ts:565-579`):

```diff
 export interface CodexHistorySyncResult {
   rows: number;
   files: number;
   ejectedRows?: number;
   failed?: true;
+  failureReason?: "sqlite_busy" | "permission_denied" | "state_unreadable";
 }
+
+export interface HistoryExecutionOptions {
+  skipWhenProvablyNoop?: boolean;
+  busyTimeoutMs?: number;
+  attempts?: number;
+  delayMs?: number;
+  sleepFn?: (ms: number) => void;
+}
@@
 export function syncCodexHistoryProvider(
   provider: CodexHistoryProvider,
   stateDbPath = STATE_DB_PATH,
   backupPath = HISTORY_BACKUP_PATH,
-  opts: { skipWhenProvablyNoop?: boolean } = {},
+  opts: HistoryExecutionOptions = {},
 ): CodexHistorySyncResult {
@@
-  return withHistoryRetry(() => syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath))
-    ?? { rows: 0, files: 0, failed: true };
+  let failureReason: CodexHistorySyncResult["failureReason"];
+  const result = withHistoryRetry(
+    () => syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath, opts.busyTimeoutMs),
+    {
+      attempts: opts.attempts,
+      delayMs: opts.delayMs,
+      sleepFn: opts.sleepFn,
+      onRecoverableError: error => { failureReason = classifyHistoryFailure(error); },
+    },
+  );
+  return result ?? { rows: 0, files: 0, failed: true, failureReason: failureReason ?? "state_unreadable" };
 }
@@
-function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbPath: string, backupPath: string): CodexHistorySyncResult {
+function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbPath: string, backupPath: string, busyTimeoutMs?: number): CodexHistorySyncResult {
@@
-  const db = openStateDb(stateDbPath);
+  const db = openStateDb(stateDbPath, busyTimeoutMs);
```

Apply the same `busyTimeoutMs` parameter to the restore-side `openStateDb` at
`src/codex/history-provider.ts:660` and to `migrateHistoryToOpenai` at
`src/codex/history-provider.ts:719-731`. Add
`onRecoverableError?: (error: unknown) => void` to `withHistoryRetry`'s `io`
parameter and call it immediately after the recoverability check at
`src/codex/history-provider.ts:544`, before the attempts check.
`classifyHistoryFailure` maps SQLite busy/locked to
`sqlite_busy`, `EPERM`/`EACCES`/permission text to `permission_denied`, and the
remaining recoverable class to `state_unreadable`; hard errors still throw. Existing
default behavior remains 5,000 ms, two attempts, and 500 ms delay
(`src/codex/history-provider.ts:511-548`).

### `src/codex/history-worker.ts` (NEW)

Implement the message contract above. The critical order is:

```ts
self.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isHistoryWorkerRequest(event.data)) return;
  const request = event.data;
  try {
    if (request.env.CODEX_HOME) process.env.CODEX_HOME = request.env.CODEX_HOME;
    if (request.env.OPENCODEX_HOME) process.env.OPENCODEX_HOME = request.env.OPENCODEX_HOME;
    const { countPendingOpencodexHistory, syncCodexHistoryProvider } = await import("./history-provider");
    const result = syncCodexHistoryProvider(request.targetProvider, request.stateDbPath, request.backupPath, {
      busyTimeoutMs: request.busyTimeoutMs,
      attempts: request.attempts,
      delayMs: request.delayMs,
      skipWhenProvablyNoop: request.skipWhenProvablyNoop,
    });
    const postProbe = request.targetProvider === "openai"
      ? countPendingOpencodexHistory(request.stateDbPath, request.backupPath)
      : null;
    self.postMessage({ type: "done", requestId: request.requestId, result, postProbe });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: request.requestId,
      reason: classifyWorkerThrownError(error),
    });
  } finally {
    try { (self as unknown as { close?: () => void }).close?.(); } catch {}
  }
};
```

`classifyWorkerThrownError` emits only the reason enum, not raw error strings or
paths. The request guard rejects non-finite/negative numeric policy fields and
non-absolute paths.

### `src/codex/history-convergence.ts` and `src/codex/history-job.ts` (NEW)

Export the normalized identity/path resolver from `history-provider.ts` so the
job, state record, and backup file cannot implement three subtly different hashes:

```diff
-function historyBackupPathFor(stateDbPath: string): string {
+export function historyStateDbId(stateDbPath: string): string {
   const normalized = process.platform === "win32" ? resolve(stateDbPath).toLowerCase() : resolve(stateDbPath);
-  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
-  return join(getConfigDir(), `codex-history-backup-${id}.json`);
+  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
 }
+function historyBackupPathFor(stateDbPath: string): string {
+  return join(getConfigDir(), `codex-history-backup-${historyStateDbId(stateDbPath)}.json`);
+}
+export function resolveCodexHistoryPaths(stateDbPath = STATE_DB_PATH): { stateDbPath: string; backupPath: string } {
+  return { stateDbPath: resolve(stateDbPath), backupPath: historyBackupPathFor(stateDbPath) };
+}
```

Also export `CodexHistoryProvider`; the Worker and job import the owner type instead
of restating a parallel union.

`history-convergence.ts` owns the schema and only these operations:

```ts
historyStateDbId(stateDbPath: string): string;
readCodexHistoryConvergence(stateDbPath?: string): HistoryConvergenceEntry | null;
beginCodexHistoryAttempt(input: AttemptInput): HistoryConvergenceEntry;
markCodexHistoryAttemptRunning(attemptId: string): HistoryConvergenceEntry;
finishCodexHistoryAttempt(attemptId: string, outcome: HistoryJobOutcome): HistoryConvergenceEntry;
```

All three writes execute a synchronous, no-await callback inside
`withConfigMutationLockSync`; malformed/unknown-version `codex.json` is
`state_unreadable` and is preserved, not replaced. `begin` fails before Worker
dispatch if the record cannot be durably written. `finish` compares `attemptId`
inside the transaction and leaves a newer entry untouched.

`history-job.ts` exports:

```ts
export type HistoryExecution = "automatic" | "explicit";
export function runCodexHistoryJob(input: {
  targetProvider: "openai" | "opencodex";
  execution: HistoryExecution;
  stateDbPath?: string;
  backupPath?: string;
  skipWhenProvablyNoop?: boolean;
}): Promise<HistoryJobOutcome>;
export function runCodexHistoryInline(input: {
  targetProvider: "openai" | "opencodex";
  stateDbPath?: string;
  backupPath?: string;
  skipWhenProvablyNoop?: boolean;
}): HistoryJobOutcome;
export function runLegacyCodexHistoryRecoveryInline(input?: {
  stateDbPath?: string;
}): HistoryJobOutcome;
export function abortCodexHistoryJobAsync(): Promise<void>;
export function setCodexHistoryJobTestHooks(hooks: {
  automaticBusyTimeoutMs?: number;
  workerTimeoutMs?: number;
} | null): void;
```

`automatic` always spawns `new Worker(new URL("./history-worker.ts",
import.meta.url).href)`, sends 100/1/0, and uses the durable transitions above.
`runCodexHistoryInline` invokes `syncCodexHistoryProvider` in the caller process
with defaults, then writes the same terminal state; the async job delegates to it
for `explicit`. The test hooks change timing only; there is no
`runInProcess` hook in the liveness test because that would make C3 vacuous.

### `src/codex/inject.ts`

Extend `InjectCodexOptions` at `src/codex/inject.ts:66-73` and replace the direct
call at `src/codex/inject.ts:601-603`:

```diff
 export interface InjectCodexOptions {
   catalogPath?: string | null;
+  historyExecution?: "automatic" | "explicit";
 }
@@
-  const history = config?.syncResumeHistory !== false
-    ? (legacyMode ? syncCodexHistoryProvider("opencodex") : migrateHistoryToOpenai())
+  const history = config?.syncResumeHistory !== false
+    ? await runCodexHistoryJob({
+        targetProvider: legacyMode ? "opencodex" : "openai",
+        execution: options.historyExecution ?? "explicit",
+      })
     : { rows: 0, files: 0 };
```

Factor `src/codex/inject.ts:765-783` into `prepareNativeCodexRestore()`
(external-provider guard, journal/config/catalog work, and
`skipWhenProvablyNoop`) and `src/codex/inject.ts:784-794` into
`finishNativeCodexRestore(prepared, history)`. The public synchronous CLI contract
remains, while the server gets an async sibling:

```diff
 export function restoreNativeCodex(): { success: boolean; message: string } {
-  const activeProvider = currentExternalCodexModelProvider();
-  // ... current config/catalog setup ...
-  const history = syncCodexHistoryProvider("openai", undefined, undefined, { skipWhenProvablyNoop });
-  // ... current message formatting ...
+  const prepared = prepareNativeCodexRestore();
+  if (prepared.done) return prepared.result;
+  const history = runCodexHistoryInline({ targetProvider: "openai", skipWhenProvablyNoop: prepared.skipWhenProvablyNoop });
+  return finishNativeCodexRestore(prepared, history);
 }
+
+/** Exit-hook fallback: restore bounded config/catalog state and leave history unresolved. */
+export function restoreNativeCodexWithoutHistory(): CodexRestoreResult {
+  const prepared = prepareNativeCodexRestore();
+  if (prepared.done) return prepared.result;
+  return finishNativeCodexRestore(prepared, preserveConvergedOrLeaveCodexHistoryPending("shutdown_cancelled"));
+}
+
+export async function restoreNativeCodexInServer(): Promise<CodexRestoreResult> {
+  const prepared = prepareNativeCodexRestore();
+  if (prepared.done) return prepared.result;
+  const history = await runCodexHistoryJob({
+    targetProvider: "openai",
+    execution: "automatic",
+    skipWhenProvablyNoop: prepared.skipWhenProvablyNoop,
+  });
+  return finishNativeCodexRestore(prepared, history);
+}
```

`CodexRestoreResult` adds `history: HistoryConvergenceEntry | null`. Its `success`
continues to describe config/catalog restoration for compatibility, but every
caller must render `history.state !== "converged"` separately; the formatter keeps
the hidden-thread warning from `src/codex/inject.ts:787-793`.

### Process-aware callers

`syncModelsToCodex` carries an explicit fifth options object rather than inferring
from port or whether a proxy happens to be live; those are not process identity:

```diff
 export async function syncModelsToCodex(
   port?: number,
   config: OcxConfig = loadConfig(),
   log: Pick<Console, "log" | "error"> | null = console,
   deps: CodexSyncDeps = defaultDeps,
+  options: { historyExecution?: "automatic" | "explicit" } = {},
 ): Promise<CodexSyncResult> {
@@
-    const result = await deps.injectCodexConfig(p, config, {});
+    const result = await deps.injectCodexConfig(p, config, {
+      ...(options.historyExecution ? { historyExecution: options.historyExecution } : {}),
+    });
@@
-  const result = await deps.injectCodexConfig(p, config, { catalogPath: catalogPathForInjection });
+  const result = await deps.injectCodexConfig(p, config, {
+    catalogPath: catalogPathForInjection,
+    ...(options.historyExecution ? { historyExecution: options.historyExecution } : {}),
+  });
```

Server callers opt in; CLI callers retain the default:

```diff
 // src/cli/index.ts:318-322 — this is the server process after listen
-  await syncModelsToCodex(port).catch(() => {});
+  await syncModelsToCodex(port, config, console, undefined, { historyExecution: "automatic" }).catch(() => {});

 // src/server/management/config-routes.ts:261-268
-    const result = await syncModelsToCodex(undefined, config, null);
+    const sync = ctx.deps.syncModelsToCodex ?? syncModelsToCodex;
+    const result = await sync(undefined, config, null, undefined, { historyExecution: "automatic" });

 // src/server/management-api.ts:167-194
-    const { restoreNativeCodex } = await import("../codex/inject");
+    const { restoreNativeCodexInServer } = await import("../codex/inject");
@@
-    const restore = restoreNativeCodex();
+    const restore = await restoreNativeCodexInServer();
@@
-    return jsonResponse(restore.success
-      ? { success: true, message: `Proxy stopping, native Codex restored.${grokNote}` }
+    return jsonResponse(restore.success
+      ? { success: true, history: restore.history, message: `Proxy stopping, native Codex restored.${historyNote}${grokNote}` }
       : { success: false, message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.${grokNote}` });
```

`historyNote` explicitly says routed threads remain hidden when state is not
`converged`. The 200 ms drain timer is scheduled only after the awaited automatic
attempt returns; under lock contention that is one 100 ms Worker attempt. Under a
large uncontended traversal the request may remain pending, but `/healthz` and
data-plane traffic continue; if the request watchdog/shutdown cancels it, durable
state remains pending.

The guardian's current synchronous `countFn` and `migrateFn` dependencies at
`src/codex/history-migration-guardian.ts:24-31` become async
`readStateFn`/`runJobFn`. Its tick awaits the single-flight job and schedules from
the durable terminal state; it never calls `countPendingOpencodexHistory` or
`migrateHistoryToOpenai` on the server thread (`src/codex/history-migration-guardian.ts:59-83`).

`drainAndShutdown` adds `abortCodexHistoryJobAsync()` to the `Promise.allSettled`
join group at `src/server/lifecycle.ts:415-418` and logs it under
`[codex-history]`. The abort
function writes `shutdown_cancelled` before resolving. The synchronous
`process.on("exit")` fallback in `src/cli/index.ts:305-310` must never start a Worker
or run history inline; graceful signal paths await the server-safe cleanup before
calling `process.exit`, while the exit fallback can only leave/rewrite unresolved
state.

The signal/exit caller split is explicit; the synchronous exit hook restores only
bounded config/catalog state, while the graceful async path runs history in a
Worker after drain:

```diff
 // src/cli/index.ts:242-266
-        const restored = restoreNativeCodex();
+        const restored = restoreNativeCodexWithoutHistory();
@@
 // src/cli/index.ts:295-301
       try {
         await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
       } finally {
+        if (!isRecyclingForExit() && !process.env.OCX_SERVICE && !currentExternalCodexModelProvider()) {
+          const historyRestore = await restoreNativeCodexInServer();
+          if (!historyRestore.success) cleanupSucceeded = false;
+        }
         const restored = syncCleanup();
         process.exit(restored ? 0 : 1);
       }
```

`/api/stop` already awaits `restoreNativeCodexInServer` before its drain timer;
the later exit hook sees idempotently restored config/catalog and does no history
work. A crash that reaches only the synchronous exit hook leaves history pending
for startup instead of freezing exit or pretending convergence.

The fallback helper preserves an already durable `converged` entry. It writes
`shutdown_cancelled` only when history is absent, running, or already unresolved;
an idempotent exit hook must not turn the `/api/stop` Worker's proven zero/zero
result back into a false negative.

All commands that execute after the proxy is stopped or in a separate CLI process
remain unchanged at their call sites: `handleStop`'s second restore
(`src/cli/index.ts:527-534`), explicit restore/eject
(`src/cli/index.ts:745-776`), service stop/uninstall
(`src/service.ts:2564-2595`, `src/service.ts:2610-2632`). Their synchronous
self-block is intentional. Legacy recovery keeps its narrower operation but routes
through the state-writing inline wrapper:

```diff
 // src/cli/index.ts:711-724
-  const r = restoreLegacyOpenaiHistory();
+  const r = runLegacyCodexHistoryRecoveryInline();
```

That wrapper calls the existing `restoreLegacyOpenaiHistory`, performs the same
post-probe, and updates `integrations/codex.json`; it does not broaden legacy
recovery into manifest restore.

### Durable read surface

Add `syncModelsToCodex?: typeof syncModelsToCodex` to `ManagementApiDeps`, use it
for `/api/sync`, and add this authenticated route beside it:

```diff
   if (url.pathname === "/api/sync" && req.method === "POST") {
     // worker-aware sync above
   }
+
+  if (url.pathname === "/api/codex/history" && req.method === "GET") {
+    const { readCurrentCodexHistoryConvergence } = await import("../../codex/history-convergence");
+    return jsonResponse({ history: readCurrentCodexHistoryConvergence() });
+  }
```

`ocx doctor` keeps its live read-only probe, because the durable fact can be stale,
but it treats a failed probe as unknown and prints durable reason/retry metadata
instead of the current generic locked-or-unreadable line
(`src/cli/doctor.ts:891-902`).

## Test plan

### C3 — real SQLite contention with measured `/healthz`

`tests/codex-history-worker-responsive.test.ts` is a server-boundary test, not a
mocked busy-error unit test:

1. Install isolated `CODEX_HOME` and `OPENCODEX_HOME` with
   `installIsolatedCodexHome`; create a production-shaped `threads` table, one
   interactive `opencodex` row, and a matching rollout using the fixture at
   `tests/codex-history-provider.test.ts:27-89`.
2. Spawn an owned Bun child with `Bun.spawn([process.execPath, "-e", source])`.
   The child opens that exact `state_5.sqlite`, executes
   `PRAGMA busy_timeout=0; BEGIN IMMEDIATE; UPDATE threads SET has_user_event =
   has_user_event`, writes `holder-ready`, and loops with `Bun.sleepSync(10)` until
   `holder-release` exists. The ready/release handshake and `finally` cleanup match
   `tests/config-mutation-lock.test.ts:48-92`. This is a separate-process SQLite
   writer lock, not a stubbed `SQLITE_BUSY`.
3. Set only `setCodexHistoryJobTestHooks({ automaticBusyTimeoutMs: 1_200 })` so
   contention lasts long enough to sample. Do not set an in-process execution hook.
4. Start `startServer(0)` with `managementApi.syncModelsToCodex` injected so the
   real `/api/sync` request calls real `injectCodexConfig` and the real Worker while
   catalog fetch is a deterministic local stub. Start the management POST but do
   not await it.
5. In parallel, issue a real `/v1/responses` request to a local test upstream that
   emits eight SSE chunks 50 ms apart; assert all eight arrive. This proves an
   already-admitted data-plane client still progresses.
6. While the management request is still pending and the child still owns the
   transaction, issue six `/healthz` requests 40 ms apart. Require every status to
   be 200. Discard the first warmup latency and require every remaining sample to
   be below `Math.floor(1_200 / 3) = 400 ms`. Also assert the management operation
   duration is at least 1,100 ms, proving the health samples overlapped contention.
   This copies the measured pattern at
   `tests/storage-restore-job-responsive.test.ts:175-210`; checking health only
   before and after the operation is not acceptance evidence.
7. Assert the management result and `GET /api/codex/history` both report unresolved
   `sqlite_busy`, with null unknown counts where the probe failed and a next retry.
8. In `finally`, write `holder-release`, await child exit code 0, reset/join the
   history Worker, drain the server, restore both homes, and delete fixtures. No
   test may delete a Worker-owned home before the Worker join; the repository has
   already observed Bun isolate failures from that ordering
   (`tests/storage-restore-job-responsive.test.ts:53-80`,
   `src/storage/worker-lifecycle.ts:1-17`).
9. Start a fresh server after lock release, trigger the persisted retry, and assert
   both the API and live post-probe become `converged` with zero/zero counts. This
   closes persistence and retry, not only responsiveness.

### Focused cases

- `tests/codex-history-provider.test.ts` — automatic options set one attempt and a
  100 ms writable timeout; no sleep callback fires; explicit defaults still make
  two attempts with one 500 ms sleep; every recoverable class gets the right reason;
  hard errors still throw (`tests/codex-history-provider.test.ts:293-369`).
- `tests/codex-history-worker.test.ts` — parity for forward retag, manifest restore,
  no-manifest ejection, line-one patch, trailing append, manifest consumption, and
  no-op. Assert only plain-data messages cross. Existing behavioral oracle:
  `tests/codex-history-provider.test.ts:92-290`.
- `tests/codex-history-worker.test.ts` — malformed message ignored; dynamic import
  sees captured homes; valid `error`, `onerror`, early `close`, watchdog timeout,
  and shutdown cancellation each join and classify once.
- `tests/codex-history-convergence.test.ts` — pending is durable before dispatch;
  state-write busy means no Worker spawn; final-write failure leaves pending/running;
  stale `attemptId` cannot overwrite a newer attempt; corrupt/unknown-version
  `codex.json` is preserved and blocks; failed probe counts are null; only clean
  zero/zero post-probe permits `converged`.
- `tests/history-migration-guardian.test.ts` — no synchronous provider probe on a
  tick, single-flight retries, finite 60-tick budget, startup re-arm of stale
  running/pending/blocked/unknown, and no retry for converged. Preserve the scheduler
  expectations currently covered at `tests/history-migration-guardian.test.ts:24-136`.
- `tests/codex-history-process-routing.test.ts` — startup, `/api/sync`, `/api/stop`,
  guardian, and graceful server cleanup select automatic Worker execution; explicit
  CLI restore/eject/recover/sync/ensure and service cleanup select inline full-budget
  execution. Assert by injected executors, not source-string matching.
- `tests/codex-sync-api.test.ts` — execution option reaches both external-provider
  and normal injection paths at `src/codex/sync.ts:49-70` and
  `src/codex/sync.ts:83-124`; result carries history status.
- `tests/shutdown-drain.test.ts` — drain awaits history termination, records
  `shutdown_cancelled`, and stops the listener even if join rejects. Existing
  storage joins remain unchanged (`src/server/lifecycle.ts:407-445`).
- `tests/codex-history-convergence.test.ts` — doctor and management status say
  routed threads remain hidden for pending/blocked/unknown, survive module reload,
  and never collapse failed-probe zeroes into success.

## Verification

Static and focused gates:

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts
bun test tests/codex-history-worker.test.ts
bun test tests/codex-history-convergence.test.ts
bun test tests/history-migration-guardian.test.ts
bun test tests/codex-sync-api.test.ts
bun test tests/codex-history-process-routing.test.ts
bun test tests/shutdown-drain.test.ts
bun test tests/codex-history-worker-responsive.test.ts
bun run privacy:scan
bun run test
```

Runtime measurement is the output of the responsiveness test, which must print or
attach this evidence on failure and success:

```text
lock_ready_at=<monotonic ms>
history_request_started_at=<monotonic ms>
health_ms=[...five post-warmup samples...]
max_health_ms=<value> threshold_ms=400
stream_chunks=8
history_elapsed_ms=<value >= 1100>
history_state=pending reason=sqlite_busy
child_exit=0 history_workers_live=0
```

The acceptance command is the real test invocation, not a prose assertion:

```bash
bun test tests/codex-history-worker-responsive.test.ts --timeout 30000
```

Do not run `ocx start`, `ocx stop`, `ocx sync`, `ocx restore`, or `ocx ensure` as
verification against the live proxy on port 10100. The isolated test server binds
port 0 and the lock child touches only its temporary Codex home.

## Accept criteria

- **C3 — measured availability:** during a real cross-process
  `BEGIN IMMEDIATE` lock on the exact history database, the automatic history
  operation remains pending for at least 1,100 ms, all six `/healthz` requests are
  200, every post-warmup sample is below 400 ms, and an eight-chunk data-plane
  stream completes. The operation executes in a Worker; no synchronous fallback
  is enabled in this test.
- **C3 — unbounded work boundary:** SQLite queries, all row/manifest traversal,
  rollout reads/writes, and fsync stay inside the Worker. No claim that the
  operation is “fast” substitutes for this boundary.
- **C4 — no silent success:** before any automatic mutation, a durable
  `pending`/`running` record exists. Busy, permissions, unreadable state, timeout,
  Worker death, and shutdown cancellation remain non-converged with classified
  reasons and nullable unknown counts.
- **C4 — proof before green:** `converged` for native restore requires a clean
  post-probe with `pendingRows=0` and `backupEntries=0`; manifest absence,
  `failed: true`, or a successful zero-row mutation is insufficient.
- **C4 — retry and visibility:** the running server retries on its bounded cadence,
  every startup re-arms durable unresolved work, explicit CLI recovery updates the
  same record, and management responses plus `ocx doctor` state that routed threads
  may remain hidden until convergence.
- CLI-process commands retain today's 5,000 ms / two-attempt / 500 ms budget;
  server-process callers use Worker + 100 ms / one attempt / no sleep.
- WP10 creates no native-write lock and no GUI switch. It is independently useful
  and independently testable before WP11.
