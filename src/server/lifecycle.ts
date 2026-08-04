import { flushResponseState } from "../responses/state";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  abortStorageCleanupPolicyJob,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { stopStorageCleanupScheduler } from "../storage/policy-scheduler";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

const activeTurns = new Map<AbortController, number>();
export const MAX_ACTIVE_TURNS = 128;
let reservedTurnSlots = 0;
let draining = false;
let recyclingForExit = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
export function setDraining(value: boolean): void { draining = value; }
export function registerTurn(ac: AbortController): void {
  if (!activeTurns.has(ac)) activeTurns.set(ac, Date.now());
}
export function unregisterTurn(ac: AbortController): void { activeTurns.delete(ac); }
export function isDraining(): boolean { return draining; }
export function getActiveTurnCount(): number { return activeTurns.size; }

export interface ActiveTurnMetrics {
  count: number;
  oldestAgeMs: number;
  ageBuckets: {
    under1s: number;
    under10s: number;
    under60s: number;
    over60s: number;
  };
}

/** Scalar-only lifecycle diagnostics; intentionally excludes request and account identity. */
export function getActiveTurnMetrics(at = Date.now()): ActiveTurnMetrics {
  let oldestAgeMs = 0;
  const ageBuckets = { under1s: 0, under10s: 0, under60s: 0, over60s: 0 };
  for (const startedAt of activeTurns.values()) {
    const ageMs = Math.max(0, at - startedAt);
    if (ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    if (ageMs < 1_000) ageBuckets.under1s += 1;
    else if (ageMs < 10_000) ageBuckets.under10s += 1;
    else if (ageMs < 60_000) ageBuckets.under60s += 1;
    else ageBuckets.over60s += 1;
  }
  return { count: activeTurns.size, oldestAgeMs, ageBuckets };
}

export interface ActiveTurnLease {
  /** Bind the lease to the controller that must be aborted when the turn is released. */
  bindAbortController(ac: AbortController): void;
  /** Release the admission slot and any bound active-turn registration exactly once. */
  release(): void;
  /** Reserved for response-body transfers; current WebSocket leases always release inline. */
  isTransferred(): boolean;
}

/**
 * Reserve a bounded turn slot before allocating the request pipeline. A stale or bursty client
 * can therefore receive a retryable 503 instead of creating an unbounded number of readers,
 * AbortControllers, and request contexts while earlier cancellations are still unwinding.
 */
export function tryAdmitTurn(): ActiveTurnLease | null {
  if (draining || activeTurns.size + reservedTurnSlots >= MAX_ACTIVE_TURNS) return null;
  reservedTurnSlots += 1;
  let released = false;
  let bound: AbortController | undefined;
  let transferred = false;
  return {
    bindAbortController(ac) {
      if (released || bound) return;
      bound = ac;
      reservedTurnSlots -= 1;
      registerTurn(ac);
    },
    release() {
      if (released) return;
      released = true;
      if (bound) {
        unregisterTurn(bound);
      } else {
        reservedTurnSlots -= 1;
      }
    },
    isTransferred: () => transferred,
  };
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
): ReadableStream<Uint8Array> {
  registerTurn(ac);
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
  draining = true;
  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (activeTurns.size > 0) {
    console.warn(`⚠️  Aborting ${activeTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
    for (const ac of activeTurns.keys()) {
      ac.abort(new Error("server shutdown"));
    }
    activeTurns.clear();
  }
  // Debounced replay-state snapshot may still be pending; flush so the last completed turn's
  // previous_response_id chain survives the restart this shutdown is usually part of.
  await flushResponseState();
  // Tear down opt-in storage policy timers / worker / live-config sink so they cannot fire after stop.
  stopStorageCleanupScheduler();
  abortStorageCleanupPolicyJob();
  setStorageCleanupPolicyLiveSink(null);
  setStorageCleanupPolicyJobLiveApply(null);
  await s?.stop(true);
  draining = false;
}
