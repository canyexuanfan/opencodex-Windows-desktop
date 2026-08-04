# WP10 — history isolation: one client turning off cannot freeze every client

Research: `002_history_off_the_loop.md`. Shared contract: `005_contract.md`.

Today, native apply/restore performs synchronous SQLite, manifest, rollout, and
fsync work on the caller thread (`src/codex/inject.ts:602,764-794`,
`src/codex/history-provider.ts:565-699`). The manifest and rollout writes are
outside the provider's SQLite transaction: apply writes manifest and rollouts
before the DB transaction (`src/codex/history-provider.ts:606-648`); restore writes
rollouts, then DB, then manifest, then performs a second ejection
(`src/codex/history-provider.ts:656-695`). A SQLite busy timeout therefore explains
only one stall and serializes only one part of the state transition.

The previous WP10 moved server work to a Worker but left explicit CLI work inline,
claimed there was no cross-process history lock, and owned a second
`integrations/codex.json` schema. Round 2 showed all three are one failure: an
opposite-direction process can overtake the Worker through the unguarded files, and
the CLI can skip the only exclusion path. Round 4 found the remaining failure: a
Worker can read pair N, a native transition can write N+1, and the Worker can then
replace JSON with stale N. Separate-file read/compare/replace is not a CAS when the
writers hold different locks. This rewrite consumes the contract's sibling history
lock and canonical-`CODEX_HOME` SQLite coordinator row (`005_contract.md` §§3, 6).

WP10 is independently landable. WP8b already supplies the coordinator-row API,
shared types, generations, and user-identity resolver; WP9 supplies the working
`convergeCodex`. WP10 adds the real history lock and Worker implementation in the
same commit that routes every history caller through it. It does not wait for the
WP11 native lock or WP12 provenance implementation to typecheck or preserve
behavior.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`2d5e080dea3e7000bf2111b381c7c1a3c4f5fb11`.

## IN / OUT

IN:

- `src/codex/history-provider.ts` (MODIFY/SPLIT) — retain only read/probe behavior;
  move every manifest, rollout, and history-DB writer into the Worker-only internal
  writer module so graph reachability can distinguish a reader from a writer.
- `src/codex/internal/history-writer.ts` (NEW) — invocation-local retry policy,
  classified internal failures, shared state-DB identity/path resolver, and the
  exact manifest/rollout/DB mutation unit reachable only from `history-worker.ts`.
- `src/codex/history-worker.ts` (NEW) — Worker entry point; applies captured homes,
  acquires the sibling cross-process history lock, rejects overtaken work, performs
  the entire history unit, probes, records, and releases.
- `src/codex/history-job.ts` (NEW) — request validation, Worker IPC/watchdog/join,
  history-lock target construction, capped retry scheduling, fresh coordinator-row
  reads after conflict, and conversion of job facts to the contract's
  `CodexHistoryState`.
- `src/codex/convergence.ts` (MODIFY) — add history execution behind the existing
  `convergeCodex`; callers still use only the contract request/result.
- `src/codex/transition-state.ts` (MODIFY only through its public API) — WP10 calls
  `readCodexTransitionState` and `updateCodexHistoryTransition`; the latter conditionally
  updates the pending history schedule where the native pair and `history_tx_id` still
  match. It never stores that pair or schedule in `integrations/codex.json`.
- `src/codex/inject.ts`, `src/codex/sync.ts` (MODIFY) — remove direct history
  execution paths and return their current non-history receipts to convergence.
- `src/codex/history-migration-guardian.ts` (MODIFY) — schedule convergence from
  durable state; never probe or mutate history on the listener thread.
- `src/cli/index.ts`, `src/cli/models.ts`, `src/cli/provider.ts`, `src/cli/v2.ts`,
  `src/service.ts` (MODIFY where they currently trigger Codex native/history work)
  — startup, explicit CLI, stop/uninstall, retry, and ensure use `convergeCodex`.
- `src/server/management-api.ts`, `src/server/management/config-routes.ts`,
  `src/server/lifecycle.ts` (MODIFY) — server work uses the same funnel and awaits
  Worker termination during drain.
- `src/cli/doctor.ts` (MODIFY) — combine a live read-only probe with the contract
  history section.
- `tests/codex-history-provider.test.ts`,
  `tests/codex-convergence-contract.test.ts`,
  `tests/history-migration-guardian.test.ts`,
  `tests/codex-sync-api.test.ts`, and `tests/shutdown-drain.test.ts` (MODIFY), plus
  `tests/codex-history-worker.test.ts`,
  `tests/codex-history-worker-responsive.test.ts`,
  `tests/codex-history-process-routing.test.ts` (NEW).

OUT:

- Any `integrations/codex.json` path, version, parser, merge algorithm, generation,
  transaction id, or pending-history schedule. Those transition facts live in the
  canonical-`CODEX_HOME` coordinator row owned by `005_contract.md`; the former
  `history-convergence.ts` schema owner is deleted from this plan.
- The claim that no cross-process history lock exists. WP10 owns its implementation
  now because the history unit is not safe without it.
- The native lock and its namespace mechanics — WP11. The history lock is a sibling,
  never a nested substitute (`005_contract.md` §6).
- `/api/sync` status, body, or header mapping — `toSyncResponse` owns that contract
  (`005_contract.md` §5).
- Ownership/provenance/desired-state policy — WP12. A Worker receives an authority
  snapshot identity; it does not invent authority.
- Traversal chunking, GUI, release/deploy operations, and the live proxy on 10100.

## Worker boundary

The Worker contains the whole mutable history unit:

1. acquire the sibling cross-process history lock;
2. read the canonical-`CODEX_HOME` coordinator row and validate its pair against
   `CommitExpectation` plus the authority snapshot identity;
3. optional no-op probe;
4. SQLite open, query, transaction, and close;
5. manifest read/write;
6. every rollout read, line-one patch, append, and fsync;
7. final post-probe;
8. conditionally update the coordinator row while still serialized, using both
   generation fields in the `WHERE` clause;
9. release the history lock.

Moving only `Database` calls is insufficient because the current manifest and
rollout mutations surround the DB transaction (`src/codex/history-provider.ts:606-648,656-695`).
Moving only automatic/server callers is insufficient because the explicit CLI path
currently reaches `restoreNativeCodex()` and `syncModelsToCodex()` directly
(`src/cli/index.ts:528,591,756,768,829`). A lock one caller can skip is not a lock.

The server remains responsive because all synchronous/unbounded history work is in
the Worker. Explicit CLI also uses the Worker; its larger wait budget may block its
own terminal, but never the proxy listener and never bypasses cross-process
serialization.

## Writer reachability has two permitted roots

The failure is structural before it is behavioral: the contract's former rule that
only `convergence.ts` may reach low-level writers is impossible for an isolated
Worker. `history-worker.ts` must invoke the history mutation after the parent has
returned to the event loop. History is therefore its own permitted production root,
not an exception hidden behind an alias.

The contract's graph/symbol guard permits exactly these history-root edges:

```text
history-worker.ts -> internal/history-writer.ts
history-worker.ts -> transition-state.ts (pair read + history schedule/terminal CAS only)
internal/history-writer.ts -> writeBackup
                           -> updateSessionMeta (line-one patch + append + fsync)
                           -> syncCodexHistoryProviderUnsafe
                           -> restoreCodexHistoryProvider
                           -> ejectRemainingOpencodexHistory
```

No CLI, server, guardian, `inject.ts`, `sync.ts`, or compatibility wrapper may reach
those history writers. Tests may import the Worker entry/funnel, not the low-level
module. Today `history-provider.ts` is mixed: it exports read-only
`readLatestSessionMeta`, `readThreadFieldsFromRollout`, and
`countPendingOpencodexHistory` beside the mutating `syncCodexHistoryProvider`,
`migrateHistoryToOpenai`, and `restoreLegacyOpenaiHistory`
(`src/codex/history-provider.ts:263,348,565,701,719,749`). A module-dependency graph
cannot tell that an importer selected only a reader. This phase must split the module:
the public provider becomes read/probe-only, while the mutating entry points and their
private manifest/rollout/DB helpers move to `internal/history-writer.ts`. Only then can
the reachability test prove the history root and the separate `convergence.ts` roots
from the contract inventory without allowing every reader import to write.

## Serializable request and response

The request carries the identity of every authority the Worker must revalidate. It
does not carry a mutable config object or a caller-chosen desired direction.

```ts
import type {
  CodexHistoryState,
  CommitExpectation,
  UserIdentity,
} from "./convergence-types";

export interface HistoryWorkerRequest {
  type: "run";
  requestId: string;
  targetProvider: "openai" | "opencodex";
  stateDbPath: string;
  backupPath: string;
  lockIdentity: {
    userIdentity: UserIdentity;
    stateDbId: string;
  };
  expectation: CommitExpectation;
  /** Digest/id of the AdmissionSnapshot that authorized this transition. */
  authoritySnapshotId: string;
  busyTimeoutMs: number;
  attempts: number;
  delayMs: number;
  skipWhenProvablyNoop: boolean;
  /** Test supervisor only: pause after the named real mutation, then await resume. */
  pauseAfter?: HistoryMutationCheckpoint;
  env: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}

export type HistoryMutationCheckpoint =
  | "manifest-write"
  | "first-rollout-write"
  | "database-write";

export interface HistoryWorkerResume {
  type: "resume";
  requestId: string;
  after: HistoryMutationCheckpoint;
}

export type HistoryWorkerMessage = HistoryWorkerRequest | HistoryWorkerResume;

export type HistoryWorkerFailureReason = NonNullable<CodexHistoryState["reason"]>;

export interface HistoryProbeCounts {
  pendingRows: number | null;
  backupEntries: number | null;
}

export type HistoryWorkerResponse =
  | {
      type: "checkpoint";
      requestId: string;
      after: HistoryMutationCheckpoint;
    }
  | {
      type: "done";
      requestId: string;
      state: CodexHistoryState;
      postProbe: HistoryProbeCounts;
      expectation: CommitExpectation;
      authoritySnapshotId: string;
    }
  | {
      type: "error";
      requestId: string;
      reason: HistoryWorkerFailureReason;
      postProbe: HistoryProbeCounts;
    };
```

Every crossing value is plain structured-clone data. The parent resolves absolute
paths and lock identity before spawn. The Worker applies captured homes before the
dynamic import because `history-provider.ts:16-22` currently binds path-derived
state at module load. The request guard rejects non-finite/negative numeric fields,
non-absolute paths, malformed identities, invalid expectations, and blank snapshot
ids.

`requestId` rejects stray messages. `authoritySnapshotId` rejects a job admitted
for different service/external/journal/provenance/intent evidence. The
`CommitExpectation` rejects a transition overtaken after native commit. These are
not optional diagnostics; missing fields make the message invalid and no mutation
starts. `pauseAfter` and `resume` are accepted only from the injected test supervisor;
they are not exposed through CLI, HTTP, config, or environment input. A checkpoint is
non-terminal, so the parent keeps the watchdog and join active until `done`/`error`.

## One sibling history lock

`src/codex/history-job.ts` constructs the history lock from the contract-owned
effective-user identity plus normalized state-DB identity. It uses a private,
persistent SQLite transaction with finite async acquisition and no PID/mtime stale
takeover. The Worker acquires it **inside the Worker** and holds it over manifest,
rollouts, DB, final probe, and terminal coordinator update.

The native and history locks are siblings:

```text
native transition: acquire native -> synchronous native commit -> release native
history transition: acquire history -> validate pair -> mutate/probe/conditional update -> release history
```

They are never held simultaneously. The history Worker never acquires the native
lock, and the native synchronous callback never spawns/awaits the Worker. This is
the checkable deadlock rule from `005_contract.md` §6.

### Overtaking prevention

Sibling locks alone allow this sequence: A commits native ON, B commits native OFF,
B removes history, then A applies history. The request therefore carries A's
`CommitExpectation`.

Immediately after taking the history lock and before any probe or mutation, the
Worker reads the coordinator row keyed by canonical `CODEX_HOME`. The job is legal
only when both row fields equal the request's `{nativeGeneration,currentTxId}`. If
another native transition has advanced either field, the Worker returns
`CodexHistoryState { status:"pending", reason:"overtaken", ... }`, performs no
history write, and does **not** retry itself. The winning/newer transition owns the
next convergence.

That first read is admission, not exclusion. B may commit a newer pair after A has
already changed the manifest, a rollout, or the DB. After the final under-lock probe,
A executes one SQLite conditional update of its result and schedule:

```sql
UPDATE codex_transition_state
   SET history_status = ?, history_reason = ?, history_attempts = ?,
       history_next_retry_at = ?, history_tx_id = ?,
       history_pending_rows = ?, history_backup_entries = ?, updated_at = ?
 WHERE singleton = 1
   AND native_generation = ?
   AND current_tx_id IS ?
   AND history_tx_id IS ?;
```

The coordinator database path already encodes effective user plus canonical
`CODEX_HOME`; the row is deliberately a singleton, not one row per
`OPENCODEX_HOME`. `updateCodexHistoryTransition(expected, state)` executes the statement
above. Its `kind:"updated"` result means exactly one changed row published A's
result; the implementation maps zero changed rows to `kind:"conflict"`. Conflict
means A was overtaken: it MUST NOT write JSON, MUST NOT overwrite or clear the newer
row's pending schedule, returns `pending/overtaken`, releases the history lock, and joins.
The parent then asks the guardian to read the current coordinator row and immediately
arm/retain the winner's schedule; it never retries A's losing transaction.

The final post-probe and conditional row update happen before release. A clean mutation
followed by an unlocked probe is not evidence: another process could change rows or
the manifest in between. For target `openai`, `converged` requires a non-failed
probe with `pendingRows === 0` and `backupEntries === 0`; manifest absence or a
zero-row mutation alone is insufficient (`src/codex/history-provider.ts:749-775`).

## Failure, timeout, and death

The parent owns one process-local Worker flight only to avoid duplicate threads;
cross-process exclusion comes from the sibling lock, not this map. Same-transition
callers may join. Opposite transitions do not overwrite each other: each reaches
the lock and the older one is rejected by its expectation.

Outcome order:

- valid `done` + clean under-lock post-probe + one-row conditional update -> contract
  `converged` state;
- SQLite/history-lock busy -> `pending/db-busy` with next retry;
- permission/refusal -> `blocked/permission`;
- unreadable data -> `unknown/unreadable` with both probe counts null;
- readable unsupported shape -> `unknown/schema` with both probe counts null;
- watchdog -> `unknown/timeout`, not `worker-died`;
- shutdown cancellation -> `unknown/shutdown-cancelled`, join, then drain;
- `worker.onerror`, malformed terminal message, or early close -> reread the
  coordinator row before attempting `unknown/worker-died`;
- initial pair/snapshot mismatch or zero-row terminal update ->
  `pending/overtaken`, no self-retry;
- coordinator update failure -> returned `unknown/record-write-failed`; the existing
  pending row is left intact for guardian repair.

The Worker closes in `finally`; the parent still waits for `close`/join using the
repository's existing discipline (`src/storage/worker-lifecycle.ts:150-209`). A
watchdog is containment, not convergence. It may interrupt legitimate large
history, so timeout can never be recorded as success.

The reread on `worker.onerror`, malformed terminal IPC, or early close is mandatory
because the Worker may have committed its terminal SQLite update and died before
`postMessage`. The parent first calls `readCodexTransitionState`. If the row still
matches the job's native pair and `history_tx_id` and already contains a terminal
history state, that durable state is the result and the parent writes nothing. If a
newer pair owns the row, the parent returns `pending/overtaken` and arms the winner's
schedule. Only when the exact job still owns a `pending` or `running` row may the
parent conditionally call
`updateCodexHistoryTransition(expected, workerDiedState)`; a zero-row result follows
the same overtaken rule. If the reread is unavailable, the parent leaves the row
intact, returns `unknown/record-write-failed`, and lets the guardian retry from
durable state. A missing terminal message is therefore never permission to
overwrite a committed success with synthetic `worker-died`.

## Fail-fast automatic mode and explicit mode

The provider currently uses a mutable global 5,000 ms busy timeout and two retries
with a synchronous 500 ms sleep (`src/codex/history-provider.ts:25-49,526-548`).
Make the policy invocation-local:

| Caller mode | Worker lock / SQLite wait | Attempts / delay | Reason |
|---|---:|---:|---|
| automatic (startup, management, guardian, stop) | 100 ms | 1 / 0 ms | Defer quickly; listener availability is the requirement. |
| explicit CLI | 5,000 ms | 2 / 500 ms | Preserve today's operator wait budget, but inside the Worker and under the same lock. |

Automatic mode never calls `sleepSync` on the parent. Explicit delay may use
`sleepSync` inside the Worker because it cannot starve the proxy or bypass the
history lock.

```diff
 export interface HistoryExecutionOptions {
   skipWhenProvablyNoop?: boolean;
+  busyTimeoutMs?: number;
+  attempts?: number;
+  delayMs?: number;
+  sleepFn?: (ms: number) => void;
 }
```

Apply `busyTimeoutMs` to both apply and restore database opens. Keep hard errors
throwing inside the Worker so its boundary can classify them once; do not turn
programming/data corruption into `db-busy`.

## Durable state consumes the coordinator row

Delete the former “Location and exact shape” JSON and the planned
`src/codex/history-convergence.ts`. The transition pair and pending history schedule
belong to the SQLite coordinator row keyed by canonical `CODEX_HOME`, not to an
`OPENCODEX_HOME` record.

Both `history-worker.ts` and `history-job.ts` consume the contract-owned coordinator
API from `src/codex/transition-state.ts`; neither owns SQL or a second row shape. The
Worker calls `readCodexTransitionState` before traversal and
`updateCodexHistoryTransition(expected, state)` after its post-probe. The parent/guardian
uses the same reader to arm the current schedule after conflict.

They never parse, write, or atomically replace `integrations/codex.json`. A terminal
history transition is one row update conditioned on canonical home plus the exact
pair. `txId` links the state to the native transition and `nextRetryAt:null` means
only “no timer armed now,” never “never again.”

The durable contract has no per-state-DB schema invented here. If multiple state
DBs need internal scheduling metadata, it remains an in-memory/job-private map;
the shared `CodexHistoryState` is the current convergence fact exposed to every
consumer.

## Retry ownership — no permanent dormancy

Delete “every 60 seconds, at most 60 ticks per process” and the interpretation of
`nextRetryAt:null` as next-startup-only. That creates permanent dormancy in a
long-lived process (carried finding #9).

**INFERRED scheduling choice:** the guardian uses capped exponential backoff with
deterministic testable jitter:

```text
delay(attempt) = min(MAX_HISTORY_RETRY_MS,
                     BASE_HISTORY_RETRY_MS * 2^min(attempt, BACKOFF_EXPONENT_CAP))
```

It schedules at most one timer and one Worker per current coordinator-row `txId`. It may back off
to the cap but never exhausts into a permanent state. Startup re-arms any unresolved
coordinator row whose timer was lost. A successful convergence clears the timer. An
`overtaken` job does not retry the losing transition; it schedules one observation
of the current generation so the winner owns work.

This loop has a finite delay per attempt and no finite lifetime attempt count.
Shutdown cancels the current timer/Worker and leaves durable unresolved state for
the next process.

## Process-aware callers use `convergeCodex`

Delete `runCodexHistoryInline`, `HistoryExecution = "automatic" | "explicit"` as a
public alternate entry point, and every caller selection that bypasses convergence.
Mode is already in `ConvergeRequest`.

```diff
-const history = syncCodexHistoryProvider("openai", ...);
+const outcome = await convergeCodex({
+  action: "converge",
+  scope: "full",
+  reason: "cli",
+  mode: "explicit",
+  deadlineMs: EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS,
+});
```

Server startup/management/guardian uses `mode:"automatic"`; explicit CLI sync,
restore, eject, recover-history, ensure, and service cleanup uses
`mode:"explicit"`. Both modes reach the **same Worker and same history lock**.
`src/codex/inject.ts:602,783` loses direct provider calls; it exposes only bounded
native apply/restore receipts to convergence.

`src/codex/convergence.ts` sequence at this phase is:

```text
admit current snapshot -> gather if ON -> native commit -> release native section
-> dispatch history Worker(expectation, authoritySnapshotId) -> observe -> outcome
```

Automatic calls may return `deferred` with unresolved `history`; explicit calls
wait only through their request deadline. Neither reports `converged` while history
is outstanding.

The synchronous `process.on("exit")` hook cannot await a Worker. It performs no
history mutation and leaves/records unresolved state; graceful signal and command
paths call convergence before exit. This preserves process shutdown without
inventing an inline escape hatch.

## Durable read surface

`GET /api/codex/history` may expose the coordinator row's `history` projection
through an authenticated read-only route. It calls `readCodexTransitionState`; it
does not define a second state type or consult the non-CAS integration JSON.

`POST /api/sync` is not redefined here. It already calls `convergeCodex` and
`toSyncResponse` after WP9 (`005_contract.md` §5). WP10 only ensures the resulting
`ConvergeOutcome` contains the contract `history` state. `ocx doctor` retains its
live read-only probe because durable state can be stale, but failed probes are
unknown rather than zero-looking success.

## Key diffs

### Worker owns lock, mutation, post-probe, and conditional row update

```diff
+self.onmessage = async (event: MessageEvent<unknown>) => {
+  const message = parseHistoryWorkerMessage(event.data);
+  if (message.type === "resume") return resumeHistoryCheckpoint(message);
+  const request = message;
+  applyCapturedHomes(request.env);
+  const lock = await acquireHistoryLock(request.lockIdentity, requestDeadline(request));
+  if (lock.status !== "acquired") return postHistoryBusy(request, lock);
+  try {
+    const expected = {
+      nativeGeneration: request.expectation.nativeAfter,
+      currentTxId: request.expectation.txId,
+    };
+    const admitted = readCodexTransitionState();
+    if (!expectationStillCurrent(admitted, expected, request.authoritySnapshotId)) {
+      return postOvertaken(request);
+    }
+    const result = syncCodexHistoryProvider(request.targetProvider, request.stateDbPath, request.backupPath, policy(request));
+    const postProbe = countPendingOpencodexHistory(request.stateDbPath, request.backupPath);
+    const state = classifyHistoryState(result, postProbe, request.expectation.txId);
+    const update = updateCodexHistoryTransition(expected, state);
+    if (update.kind === "conflict") return postOvertaken(request, postProbe);
+    if (update.kind === "unavailable") return postRecordWriteFailed(request, postProbe);
+    self.postMessage({ type: "done", requestId: request.requestId, state, postProbe, expectation: request.expectation, authoritySnapshotId: request.authoritySnapshotId });
+  } finally {
+    lock.release();
+    closeWorker();
+  }
+};
```

`release()` above is private to Worker implementation; unlike the native public
API, no caller can retain it across unrelated work.

The parent terminal handler does not map missing IPC directly to `worker-died`.
Its error/close branch performs the reread rule above after join: adopt a matching
terminal row, arm a newer winner, or conditionally publish `worker-died` only while
the exact job still owns `pending`/`running`. This branch is tested at the seam
between the Worker's successful SQLite commit and `postMessage`.

### Convergence dispatch, no inline branch

```diff
-historyExecution === "explicit"
-  ? runCodexHistoryInline(input)
-  : runCodexHistoryJob(input)
+await runCodexHistoryJob({
+  ...input,
+  mode: request.mode,
+  expectation,
+  authoritySnapshotId: admittedSnapshotId(admission),
+})
```

## Test plan

### Opposite-direction cross-process serialization

1. Seed production-shaped DB, manifest, and rollouts in isolated homes.
2. Process A enters production `convergeCodex({scope:"full"})`; its real Worker
   requests `pauseAfter:"first-rollout-write"`. The Worker performs the manifest and
   first rollout mutations, posts `checkpoint {requestId, after}`, and waits for a
   matching `resume` IPC message while still holding the history lock.
3. Process B converges OFF and commits the newer coordinator pair while A is paused.
   B's history Worker waits on the history lock; native pair advancement does not.
4. Resume A. Its remaining traversal and post-probe complete, but its terminal
   conditional row update affects zero rows. Assert A returns `pending/overtaken`,
   never touches the newer pending schedule, releases/joins, and causes the guardian
   to arm B from the current row.
5. Let B acquire history and repair every manifest, rollout, and DB sentinel. Reverse
   direction/order and repeat. Final history must match the highest native generation,
   not Worker scheduling order.

The checkpoint is deterministic because it is acknowledged only after the real
writer reports a completed surface mutation, and resume is keyed by `requestId`.
There is no alternate provider stub or direct test-only mutation path: both processes
enter the production convergence/job/Worker protocol. A same-process flight, a pause
before traversal, or two connections without manifest/rollout/DB sentinels does not
satisfy C15.

### CLI contention

- Hold the production history lock in a child. Invoke an explicit CLI convergence
  through its function-level command handler with `mode:"explicit"`; assert it
  waits/returns the typed contract outcome and performs no inline provider call.
- In parallel trigger automatic server convergence; assert listener health/data
  plane progress while both processes contend.
- Release, join both Workers, and prove one serialized winner. The test inspects the
  transition row through `readCodexTransitionState`, not a WP10 parser.

### Post-probe under lock

- Inject a competing child that attempts to change a history row and manifest at
  the probe seam. Assert it cannot proceed until after terminal state is recorded
  and lock released.
- A failed probe, nonzero pending rows, or nonempty backup entries remains
  non-converged. Only clean zero/zero becomes `converged`.

### Retry and death

- Advance a fake monotonic clock through exponential growth and the cap; prove a
  later timer always exists for unresolved current work and no 60-tick terminal
  state exists.
- Restart/module reload re-arms unresolved state.
- Worker error, malformed response, early close, watchdog, cancellation, and final
  coordinator-row write failure retain their distinct contract reasons, carry nullable
  probe counts, remain non-converged, and join exactly once. For
  error/malformed/close, the parent rereads first: an already-terminal matching row
  wins; only a matching `pending`/`running` row may be conditionally changed to
  `worker-died`.
- An overtaken transition does not retry itself.

### Measured responsiveness — C3

Keep the real `BEGIN IMMEDIATE` holder and overlapping `/healthz` plus eight-chunk
SSE test from the prior plan, but route the request through production
`convergeCodex`. Bind port `0`; use temporary homes. Require the management/history
request to overlap contention, every health response to be 200, the stream to
complete, and the durable state to report `db-busy` before succeeding after release.

## Verification

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts tests/codex-history-worker.test.ts
bun test tests/history-migration-guardian.test.ts tests/codex-history-process-routing.test.ts
bun test tests/codex-sync-api.test.ts tests/shutdown-drain.test.ts
bun test tests/codex-history-worker-responsive.test.ts --timeout 30000
bun run privacy:scan
bun run test
```

The responsiveness test prints lock-ready time, overlapping health latencies,
stream chunk count, history elapsed time/state, child exit, and live Worker count.
No verification command invokes `ocx start`, `ocx stop`, `ocx sync`, `ocx restore`,
or `ocx ensure`; port 10100 remains untouched.

## Accept criteria

- **C3** — all synchronous/unbounded history work is in the Worker; real contention
  overlaps responsive `/healthz` and data-plane traffic.
- **C4** — unresolved work is durably represented by the contract
  `CodexHistoryState`, retried with capped non-permanent backoff, and never collapsed
  into success. Clean post-probe occurs under the history lock.
- **C15** — opposite-direction processes serialize manifest, rollouts, DB, probe,
  and terminal coordinator update; the pair-conditioned row update detects an
  overtake even after the stale Worker has mutated a history surface, preserves the
  winner's pending schedule, and drives repair.
- Explicit CLI and automatic server/startup/retry callers all enter through
  `convergeCodex` and the same sibling history lock. No inline escape hatch remains.
- **N2** — WP10 imports the WP8b coordinator/types and extends WP9's working funnel. Its
  commit typechecks and preserves behavior without any WP11/WP12 placeholder.
