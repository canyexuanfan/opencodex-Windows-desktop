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
the CLI can skip the only exclusion path. This rewrite consumes the contract's
sibling history-lock protocol and record section (`005_contract.md` §§1, 3, 6).

WP10 is independently landable. WP8b already supplies the record updater, shared
types, generations, and user-identity resolver; WP9 supplies the working
`convergeCodex`. WP10 adds the real history lock and Worker implementation in the
same commit that routes every history caller through it. It does not wait for the
WP11 native lock or WP12 provenance implementation to typecheck or preserve
behavior.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`2d5e080dea3e7000bf2111b381c7c1a3c4f5fb11`.

## IN / OUT

IN:

- `src/codex/history-provider.ts` (MODIFY) — invocation-local retry policy,
  classified internal failures, shared state-DB identity/path resolver, and a
  post-probe callable while the history lock is still held.
- `src/codex/history-worker.ts` (NEW) — Worker entry point; applies captured homes,
  acquires the sibling cross-process history lock, rejects overtaken work, performs
  the entire history unit, probes, records, and releases.
- `src/codex/history-job.ts` (NEW) — request validation, Worker IPC/watchdog/join,
  history-lock target construction, capped retry scheduling, and conversion of job
  facts to the contract's `CodexHistoryState`.
- `src/codex/convergence.ts` (MODIFY) — add history execution behind the existing
  `convergeCodex`; callers still use only the contract request/result.
- `src/codex/integration-record.ts` (MODIFY only through its public updater) — no
  schema change. WP10 calls `updateIntegrationRecord` to write the optional
  `history` section and native expected transition atomically.
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
  `tests/history-migration-guardian.test.ts`,
  `tests/codex-sync-api.test.ts`, and `tests/shutdown-drain.test.ts` (MODIFY), plus
  `tests/codex-history-worker.test.ts`,
  `tests/codex-history-worker-responsive.test.ts`,
  `tests/codex-history-process-routing.test.ts` (NEW).

OUT:

- Any `integrations/codex.json` path, version, parser, merge algorithm, or schema.
  `src/codex/integration-record.ts` and `CodexHistoryState` are owned by
  `005_contract.md` §1. The former `history-convergence.ts` schema owner is deleted
  from this plan.
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
2. validate `CommitExpectation` and authority snapshot identity;
3. optional no-op probe;
4. SQLite open, query, transaction, and close;
5. manifest read/write;
6. every rollout read, line-one patch, append, and fsync;
7. final post-probe;
8. update the contract record while still serialized;
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

## Serializable request and response

The request carries the identity of every authority the Worker must revalidate. It
does not carry a mutable config object or a caller-chosen desired direction.

```ts
import type {
  CodexHistoryState,
  CommitExpectation,
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
  env: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}

export type HistoryWorkerResponse =
  | {
      type: "done";
      requestId: string;
      state: CodexHistoryState;
      postProbe: PendingHistoryCount;
      expectation: CommitExpectation;
      authoritySnapshotId: string;
    }
  | {
      type: "error";
      requestId: string;
      reason: "db-busy" | "permission" | "worker-died" | "overtaken";
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
starts.

## One sibling history lock

`src/codex/history-job.ts` constructs the history lock from the contract-owned
effective-user identity plus normalized state-DB identity. It uses a private,
persistent SQLite transaction with finite async acquisition and no PID/mtime stale
takeover. The Worker acquires it **inside the Worker** and holds it over manifest,
rollouts, DB, final probe, and terminal record update.

The native and history locks are siblings:

```text
native transition: acquire native -> synchronous native commit -> release native
history transition: acquire history -> validate expectation -> mutate/probe/record -> release history
```

They are never held simultaneously. The history Worker never acquires the native
lock, and the native synchronous callback never spawns/awaits the Worker. This is
the checkable deadlock rule from `005_contract.md` §6.

### Overtaking prevention

Sibling locks alone allow this sequence: A commits native ON, B commits native OFF,
B removes history, then A applies history. The request therefore carries A's
`CommitExpectation`.

Immediately after taking the history lock and before any probe or mutation, the
Worker reads the integration record. The job is legal only when the record still
names the transition expected by the request. If another native transition has
advanced the generation/transaction identity, the Worker returns
`CodexHistoryState { status:"pending", reason:"overtaken", ... }`, performs no
history write, and does **not** retry itself. The winning/newer transition owns the
next convergence.

The final post-probe and record update happen before release. A clean mutation
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

- valid `done` + clean under-lock post-probe -> contract `converged` state;
- SQLite/history-lock busy -> `pending/db-busy` with next retry;
- permission/refusal -> `blocked/permission`;
- expectation/snapshot mismatch -> `pending/overtaken`, no self-retry;
- `worker.onerror`, malformed terminal message, early close, or watchdog ->
  `unknown/worker-died`;
- shutdown cancellation -> persist non-converged state, join, then drain.

The Worker closes in `finally`; the parent still waits for `close`/join using the
repository's existing discipline (`src/storage/worker-lifecycle.ts:150-209`). A
watchdog is containment, not convergence. It may interrupt legitimate large
history, so timeout can never be recorded as success.

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

## Durable state consumes the contract record

Delete the former “Location and exact shape” JSON and the planned
`src/codex/history-convergence.ts`. The path, top-level version, extension policy,
and section schema belong to `005_contract.md` §1.

Both `history-worker.ts` and `history-job.ts` import:

```ts
import type { CodexHistoryState } from "./convergence-types";
import {
  readIntegrationRecord,
  updateIntegrationRecord,
} from "./integration-record";
```

They never parse or atomically replace `integrations/codex.json` themselves. A
state transition is one `updateIntegrationRecord(record => ({ ...record, history:
next }))`; unknown keys and the provenance section survive. Corrupt/unparseable
records fail closed. `txId` links the state to the native transition and
`nextRetryAt:null` means only “no timer armed now,” never “never again.”

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

It schedules at most one timer and one Worker per current `txId`. It may back off
to the cap but never exhausts into a permanent state. Startup re-arms any unresolved
record whose timer was lost. A successful convergence clears the timer. An
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

`GET /api/codex/history` may expose the contract record's `history` section through
an authenticated read-only route. It imports `readIntegrationRecord`; it does not
define a second state type.

`POST /api/sync` is not redefined here. It already calls `convergeCodex` and
`toSyncResponse` after WP9 (`005_contract.md` §5). WP10 only ensures the resulting
`ConvergeOutcome` contains the contract `history` state. `ocx doctor` retains its
live read-only probe because durable state can be stale, but failed probes are
unknown rather than zero-looking success.

## Key diffs

### Worker owns lock, mutation, post-probe, and record

```diff
+self.onmessage = async (event: MessageEvent<unknown>) => {
+  const request = parseHistoryWorkerRequest(event.data);
+  applyCapturedHomes(request.env);
+  const lock = await acquireHistoryLock(request.lockIdentity, requestDeadline(request));
+  if (lock.status !== "acquired") return postHistoryBusy(request, lock);
+  try {
+    const current = readIntegrationRecord();
+    if (!expectationStillCurrent(current, request.expectation, request.authoritySnapshotId)) {
+      return postOvertaken(request);
+    }
+    const result = syncCodexHistoryProvider(request.targetProvider, request.stateDbPath, request.backupPath, policy(request));
+    const postProbe = countPendingOpencodexHistory(request.stateDbPath, request.backupPath);
+    const state = classifyHistoryState(result, postProbe, request.expectation.txId);
+    updateIntegrationRecord(record => ({ ...record, history: state }));
+    self.postMessage({ type: "done", requestId: request.requestId, state, postProbe, expectation: request.expectation, authoritySnapshotId: request.authoritySnapshotId });
+  } finally {
+    lock.release();
+    closeWorker();
+  }
+};
```

`release()` above is private to Worker implementation; unlike the native public
API, no caller can retain it across unrelated work.

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
2. Process A converges ON and pauses after acquiring the real history lock.
3. Process B converges OFF. Assert B cannot mutate manifest, rollout, or DB while A
   holds the lock.
4. Let B win the newer native `CommitExpectation`; release A. Assert A is rejected
   as `overtaken` before its first history write and B alone produces final OFF
   history.
5. Reverse direction/order and repeat. Final history must match the highest native
   generation, not Worker scheduling order.

This is real two-process SQLite/filesystem behavior. A same-process flight or two
connections without rollout sentinels does not satisfy C15.

### CLI contention

- Hold the production history lock in a child. Invoke an explicit CLI convergence
  through its function-level command handler with `mode:"explicit"`; assert it
  waits/returns the typed contract outcome and performs no inline provider call.
- In parallel trigger automatic server convergence; assert listener health/data
  plane progress while both processes contend.
- Release, join both Workers, and prove one serialized winner. The test inspects the
  integration record through its owner, not a WP10 parser.

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
  record-write failure remain non-converged and join exactly once.
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
  and record update; `CommitExpectation` prevents overtaking.
- Explicit CLI and automatic server/startup/retry callers all enter through
  `convergeCodex` and the same sibling history lock. No inline escape hatch remains.
- **N2** — WP10 imports the WP8b record/types and extends WP9's working funnel. Its
  commit typechecks and preserves behavior without any WP11/WP12 placeholder.
