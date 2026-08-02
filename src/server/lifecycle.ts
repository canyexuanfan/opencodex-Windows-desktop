import { flushResponseState } from "../responses/state";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  abortStorageCleanupPolicyJobAsync,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { abortRestoreTrashJobAsync } from "../storage/restore-job";
import { stopStorageCleanupScheduler } from "../storage/policy-scheduler";
import { stopStateStoreSweeper } from "../lib/state-store-sweeper";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
} from "../storage/worker-lifecycle";
import { createAdmissionGate, type AdmissionLease, type AdmissionMetrics } from "../lib/admission";
import { codexWebSocketAdmissionMetrics } from "../codex/websocket-registry";
import { storageMutationAdmissionMetrics } from "../storage/storage-mutation-coordinator";
import { storageWorkerAdmissionMetrics } from "../storage/worker-lifecycle";
import {
  backgroundShellAdmissionMetrics,
  beginBackgroundShellShutdown,
  terminateAllBackgroundShells,
} from "../adapters/cursor/native-exec-shell";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_TURNS = 256;
const turnGate = createAdmissionGate("active_turns", MAX_ACTIVE_TURNS);
export interface ActiveTurnLease extends AdmissionLease {
  bindAbortController(ac: AbortController): void;
  isTransferred(): boolean;
}
const activeTurns = new Map<AbortController, ActiveTurnLease>();
const admittedTurns = new Set<ActiveTurnLease>();
const knownTurnControllers = new WeakSet<AbortController>();
let turnReleaseMisses = 0;
let shutdownDraining = false;
const temporaryDrainOwners = new Set<symbol>();
const temporaryDrainWaiters = new Set<() => void>();
let legacyDrainLease: AdmissionLease | null = null;
let recyclingForExit = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
/**
 * Legacy/test-only drain control. Production scoped operations must use a lease,
 * while process shutdown uses the irreversible shutdown latch.
 */
export function setDraining(value: boolean): void {
  if (value) {
    legacyDrainLease ??= acquireTemporaryDrain("legacy");
  } else {
    legacyDrainLease?.release();
    legacyDrainLease = null;
  }
}

/** Acquire the single owner-scoped temporary data-plane fence. */
export function acquireTemporaryDrain(owner: string): AdmissionLease | null {
  if (shutdownDraining || temporaryDrainOwners.size > 0) return null;
  const token = Symbol(owner);
  temporaryDrainOwners.add(token);
  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      temporaryDrainOwners.delete(token);
      if (temporaryDrainOwners.size === 0) {
        for (const resolve of temporaryDrainWaiters) resolve();
        temporaryDrainWaiters.clear();
      }
    },
  };
}

/** Permanently fence this process for shutdown; scoped lease release cannot clear it. */
export function beginShutdownDrain(): boolean {
  if (shutdownDraining) return false;
  shutdownDraining = true;
  return true;
}

export function isShutdownDraining(): boolean { return shutdownDraining; }

export function waitForTemporaryDrains(): Promise<void> {
  if (temporaryDrainOwners.size === 0) return Promise.resolve();
  return new Promise(resolve => temporaryDrainWaiters.add(resolve));
}

/** Wait for scoped drains without allowing them to outlive the shutdown deadline. */
async function waitForTemporaryDrainsUntil(deadlineMs: number): Promise<boolean> {
  if (temporaryDrainOwners.size === 0) return true;
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(drained);
    };
    timer = setTimeout(() => finish(false), remainingMs);
    void waitForTemporaryDrains().then(() => finish(true));
  });
}

/** Test-only process-lifetime reset. Never call from production recovery paths. */
export function resetLifecycleDrainStateForTests(): void {
  legacyDrainLease?.release();
  legacyDrainLease = null;
  temporaryDrainOwners.clear();
  for (const resolve of temporaryDrainWaiters) resolve();
  temporaryDrainWaiters.clear();
  shutdownDraining = false;
}
export function tryAdmitTurn(): ActiveTurnLease | null {
  if (isDraining()) return null;
  const gateLease = turnGate.tryAcquire();
  if (!gateLease) return null;
  const controllers = new Set<AbortController>();
  let active = true;
  let transferred = false;
  const lease: ActiveTurnLease = {
    bindAbortController(ac) {
      knownTurnControllers.add(ac);
      if (!active) {
        ac.abort(new Error("turn already settled"));
        return;
      }
      transferred = true;
      controllers.add(ac);
      activeTurns.set(ac, lease);
    },
    isTransferred() { return transferred; },
    release() {
      if (!active) return;
      active = false;
      admittedTurns.delete(lease);
      for (const controller of controllers) {
        if (activeTurns.get(controller) === lease) activeTurns.delete(controller);
      }
      controllers.clear();
      gateLease.release();
    },
  };
  admittedTurns.add(lease);
  return lease;
}
export function registerTurn(ac: AbortController, lease?: AdmissionLease): void {
  if (lease && "bindAbortController" in lease) (lease as ActiveTurnLease).bindAbortController(ac);
}
export function unregisterTurn(ac: AbortController): void {
  const lease = activeTurns.get(ac);
  if (!lease) {
    if (knownTurnControllers.has(ac)) return;
    turnReleaseMisses += 1;
    return;
  }
  lease.release();
}
export function isDraining(): boolean { return shutdownDraining || temporaryDrainOwners.size > 0; }
export function getActiveTurnCount(): number { return turnGate.metrics().active; }
export function activeRegistryMetrics(): Record<string, AdmissionMetrics> {
  const turns = turnGate.metrics();
  return {
    activeTurns: { ...turns, releaseMisses: turns.releaseMisses + turnReleaseMisses },
    codexWebSockets: codexWebSocketAdmissionMetrics(),
    cursorBackgroundShells: backgroundShellAdmissionMetrics(),
    storageHomeSlots: storageMutationAdmissionMetrics(),
    storageWorkerReservations: storageWorkerAdmissionMetrics(),
  };
}

export function abortAndReleaseAllTurns(reason: unknown = new Error("server shutdown")): void {
  const owners = [...admittedTurns];
  for (const owner of owners) {
    const controllers = [...activeTurns].filter(([, lease]) => lease === owner).map(([controller]) => controller);
    for (const controller of controllers) controller.abort(reason);
    owner.release();
  }
}
/** Live listen port of the Bun server, when started. */
export function getServerListenPort(): number | undefined {
  const port = _serverRef?.port;
  return typeof port === "number" && port > 0 ? port : undefined;
}
/**
 * Mark this process as a recycle (dashboard drain-and-restart). Exit cleanup
 * must keep Codex/Grok/system-env injection so the replacement process inherits
 * a working fence — unlike an intentional `ocx stop` teardown.
 */
export function markRecyclingForExit(): void { recyclingForExit = true; }
export function isRecyclingForExit(): boolean { return recyclingForExit; }

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  onDone?: () => void,
  lease?: AdmissionLease,
): ReadableStream<Uint8Array> {
  registerTurn(ac, lease);
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unregisterTurn(ac);
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        finish();
        try { controller.error(err); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      finish();
      ac.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export async function drainAndShutdown(
  server: ReturnType<typeof Bun.serve> | undefined,
  timeoutMs: number,
): Promise<void> {
  const s = server ?? _serverRef;
  // One absolute budget covers both a pre-existing scoped profile drain and
  // ordinary in-flight turns. A stuck scoped owner must not pin shutdown forever.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  beginShutdownDrain();
  const temporaryDrainsSettled = await waitForTemporaryDrainsUntil(deadline);
  if (!temporaryDrainsSettled) {
    console.warn("Temporary drain lease did not settle before the shutdown deadline; forcing shutdown");
  }
  beginBackgroundShellShutdown();
  try {
    while (admittedTurns.size > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    if (admittedTurns.size > 0) {
      console.warn(`⚠️  Aborting ${admittedTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
      abortAndReleaseAllTurns(new Error("server shutdown"));
    }

    const shellDrain = await Promise.allSettled([terminateAllBackgroundShells()]);
    const shellResult = shellDrain[0]!;
    if (shellResult.status === "rejected") {
      console.warn("[cursor] background shell drain failed", { rejected: 1 });
    } else if (shellResult.value.unresolved > 0 || shellResult.value.killFailures > 0) {
      console.warn("[cursor] background shell drain incomplete", shellResult.value);
    }

    // Debounced replay-state snapshot may still be pending; flush so the last completed turn's
    // previous_response_id chain survives the restart this shutdown is usually part of.
    const responseStateFlush = await Promise.allSettled([flushResponseState()]);
    if (responseStateFlush[0]?.status === "rejected") {
      console.warn("[responses] state flush during shutdown failed");
    }

    // Tear down opt-in storage policy timers / worker / live-config sink so they cannot fire after stop.
    // Await worker thread exit: on Windows, a still-exiting Bun Worker under
    // `bun test --isolate` panics the whole process at the next realm reclaim.
    // Abort each job independently so one wedged join cannot skip the other,
    // then drain leftovers; failures must not prevent `server.stop`.
    stopStorageCleanupScheduler();
    stopStateStoreSweeper();
    cancelQueuedStorageWorkerSpawns();
    const shutdownJoins = await Promise.allSettled([
      abortStorageCleanupPolicyJobAsync(),
      abortRestoreTrashJobAsync(),
    ]);
    for (const result of shutdownJoins) {
      if (result.status === "rejected") {
        console.warn(
          "[storage] worker abort during shutdown failed:",
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      }
    }
    try {
      await drainStorageWorkers();
    } catch (err) {
      console.warn(
        "[storage] worker drain during shutdown failed:",
        err instanceof Error ? err.message : err,
      );
    }
    setStorageCleanupPolicyLiveSink(null);
    setStorageCleanupPolicyJobLiveApply(null);
  } finally {
    try {
      // Bun's Server.stop returns Promise<void>; fire-and-forget races the next
      // isolate reclaim / follow-on listen the same way unterminated Workers did.
      if (s) await s.stop(true);
    } finally {
      // shutdownDraining is a process-lifetime latch. A stopped server must
      // never resume admission merely because shutdown cleanup returned.
    }
  }
}
