/**
 * Deterministic teardown for the storage Bun Workers.
 *
 * `Worker.terminate()` returns void and does NOT wait for the thread to be
 * reclaimed. Callers that fire-and-forget leave a window where
 * `bun test --isolate` reclaims the file realm while a Windows worker thread
 * is still exiting — Bun then panics with
 * `workers_spawned(N) workers_terminated(N-1)` / Internal assertion failure.
 *
 * Invariant: every registered worker has a `close` listener attached at spawn
 * time (so we cannot miss `self.close()` / early exit), stays in `liveWorkers`
 * until that close settles, and `drainStorageWorkers()` joins every in-flight
 * terminate. Spawns are serialized through `withStorageWorkerSpawnGate` so the
 * next Worker cannot be created until prior threads have exited. On Windows and
 * macOS, a post-close settle covers the OS join gap Bun does not expose
 * (Windows unbalanced join panic; macOS Silicon balanced-count segfault under
 * `bun test --isolate`).
 */

type TrackedWorker = {
  worker: Worker;
  closed: Promise<void>;
  resolveClosed: () => void;
  terminatePromise?: Promise<void>;
};

const liveWorkers = new Map<Worker, TrackedWorker>();

/** Serialize spawns so a new Worker never overlaps a still-exiting predecessor. */
let spawnGate: Promise<void> = Promise.resolve();

/**
 * Bumped by teardown so a spawn still queued on `spawnGate` (not yet in
 * `liveWorkers`) cannot create a Worker after reset/shutdown reported idle.
 */
let spawnCancelEpoch = 0;

/**
 * OS-join gap after the `close` event on platforms where Bun's Worker reclaim
 * races the isolate/file boundary (not a CI job-timeout bump).
 */
const WORKER_OS_JOIN_MS = 250;

function needsWorkerOsJoinSettle(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/** Invalidate spawn callbacks still waiting on the gate (reset / server drain). */
export function cancelQueuedStorageWorkerSpawns(): void {
  spawnCancelEpoch += 1;
}

/** Track a freshly spawned worker so teardown can wait for it later. */
export function registerStorageWorker(worker: Worker): void {
  if (liveWorkers.has(worker)) return;

  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  const tracked: TrackedWorker = { worker, closed, resolveClosed };
  liveWorkers.set(worker, tracked);

  try {
    worker.addEventListener("close", () => {
      resolveClosed();
    }, { once: true });
  } catch {
    // No close event — terminate path will still resolve via timeout/settle.
  }
}

/**
 * Run `fn` only after every previously gated spawn has finished tearing down.
 * Used around `new Worker(...)` so tests cannot overlap Windows thread exit.
 */
export function withStorageWorkerSpawnGate<T>(fn: () => Promise<T>): Promise<T> {
  const epochAtEnqueue = spawnCancelEpoch;
  const run = spawnGate.then(async () => {
    if (epochAtEnqueue !== spawnCancelEpoch) {
      throw new Error("storage_worker_spawn_cancelled");
    }
    await drainStorageWorkers();
    if (epochAtEnqueue !== spawnCancelEpoch) {
      throw new Error("storage_worker_spawn_cancelled");
    }
    return fn();
  });
  spawnGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Terminate a worker and resolve once its thread has actually exited.
 *
 * Safe to call twice: the second call joins the in-flight terminate promise.
 */
export function terminateStorageWorker(worker: Worker, timeoutMs = 5_000): Promise<void> {
  const tracked = liveWorkers.get(worker);
  if (!tracked) {
    try { worker.terminate(); } catch { /* already gone */ }
    return Promise.resolve();
  }
  if (tracked.terminatePromise) return tracked.terminatePromise;

  tracked.terminatePromise = (async () => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      tracked.resolveClosed();
    }, timeoutMs);

    try {
      try {
        worker.terminate();
      } catch {
        tracked.resolveClosed();
      }
      await tracked.closed;
      // Always run the OS-join settle before throwing on timeout: the timer
      // only forces `closed`, it does not prove the OS thread has exited.
      // Callers that catch and continue (e.g. drainAndShutdown) still need
      // that gap before the next isolate reclaim or server.stop.
      if (needsWorkerOsJoinSettle()) {
        await Bun.sleep(0);
        await Bun.sleep(WORKER_OS_JOIN_MS);
      }
      if (timedOut) {
        throw new Error(`storage worker did not exit within ${timeoutMs}ms`);
      }
    } finally {
      clearTimeout(timer);
      liveWorkers.delete(worker);
    }
  })();

  return tracked.terminatePromise;
}

/**
 * Await every worker this module still tracks (including terminations already
 * in flight). Used by test resets so no storage worker outlives the file that
 * spawned it.
 */
export async function drainStorageWorkers(timeoutMs = 5_000): Promise<void> {
  const pending = [...liveWorkers.keys()].map(worker => terminateStorageWorker(worker, timeoutMs));
  await Promise.all(pending);
}

/** Live worker count — exported so a regression test can assert the invariant. */
export function liveStorageWorkerCount(): number {
  return liveWorkers.size;
}
