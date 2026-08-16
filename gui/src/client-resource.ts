import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

export type ResourceSnapshot<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /**
   * A request is in flight. Unlike `loading`, this never means "replace the content":
   * a quiet poll over cached data raises only this, so a slow revalidation stays visible
   * without blanking the surface.
   */
  refreshing: boolean;
  /** Set once a fetch resolved successfully for this key. Survives later failures. */
  hasSucceeded: boolean;
  /** False when the latest settled attempt failed, so stale-but-shown differs from healthy. */
  lastAttemptOk: boolean;
};

type Store<T> = {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  /** listener → requested poll interval (undefined = no poll from that subscriber) */
  pollByListener: Map<() => void, number | undefined>;
  /**
   * listener → whether that subscriber's poll may be skipped while the document is hidden.
   *
   * Per subscriber rather than per store: a fixed key can be shared by consumers with
   * different needs, and one opt-out must not be lost because a peer subscribed later.
   */
  pauseWhenHiddenByListener: Map<() => void, boolean>;
  /** listener → fetcher owned by that subscriber */
  fetcherByListener: Map<() => void, (signal: AbortSignal) => Promise<T>>;
  /** listener → per-attempt deadline owned by that subscriber (undefined = default) */
  deadlineByListener: Map<() => void, number | undefined>;
  subscriberCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Currently scheduled poll interval; avoids resetting the countdown on churn. */
  pollIntervalMs: number | undefined;
  /**
   * Hidden with no opt-out subscriber: the timer is GONE (not just skipped) and only
   * a visibility transition back to visible re-arms it. pollIntervalMs survives
   * suspension so churn cannot re-arm through the changed-interval path.
   */
  pollSuspended: boolean;
  inflight: AbortController | null;
  /** Subscriber that started the current in-flight request (if any). */
  inflightOwner: (() => void) | null;
  /** Store-level visibilitychange handler, installed only while this store polls. */
  visibilityListener: (() => void) | null;
  generation: number;
  /**
   * Set when `setClientResourceData` publishes while nobody is subscribed (session-cache
   * seed). The first subscribe must quiet-revalidate; otherwise mount never fetches and
   * seeded rows stay indefinitely stale with `lastAttemptOk: true`.
   */
  seedNeedsRevalidate: boolean;
};

/**
 * Module cache keyed by string. Call sites must not reuse the same key for
 * different resource types (no runtime check — keys are an API contract).
 */
const stores = new Map<string, Store<unknown>>();

/**
 * Per-attempt deadline for every store fetch. Endpoints documented as slow finish in
 * ~5s; 30s leaves generous headroom. Without this a hung request wedges the store
 * forever: poll ticks skip while inflight and no abort ever fires on its own.
 */
const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
/** Abort-reason sentinel distinguishing the deadline from owner aborts (replace/unmount). */
const RESOURCE_TIMEOUT = "ocx-resource-deadline";

const EMPTY_SNAPSHOT: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
  loading: false,
  refreshing: false,
  hasSucceeded: false,
  lastAttemptOk: false,
};

function getStore<T>(key: string): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    store = {
      snapshot: {
        data: undefined,
        error: undefined,
        loading: false,
        refreshing: false,
        hasSucceeded: false,
        lastAttemptOk: false,
      },
      listeners: new Set(),
      pollByListener: new Map(),
      pauseWhenHiddenByListener: new Map(),
      fetcherByListener: new Map(),
      deadlineByListener: new Map(),
      subscriberCount: 0,
      pollTimer: null,
      pollIntervalMs: undefined,
      pollSuspended: false,
      inflight: null,
      inflightOwner: null,
      visibilityListener: null,
      generation: 0,
      seedNeedsRevalidate: false,
    };
    stores.set(key, store);
  }
  return store;
}

function emit<T>(store: Store<T>) {
  for (const listener of store.listeners) listener();
}

function clearPollTimer<T>(store: Store<T>) {
  if (store.pollTimer !== null) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
  store.pollIntervalMs = undefined;
}

/**
 * Clear only the timer and mark the store suspended. Unlike clearPollTimer this
 * KEEPS pollIntervalMs — clearing it would let hidden-phase subscriber churn
 * (StrictMode, tab mounts) re-arm a fresh interval through recomputePoll's
 * changed-interval path.
 */
function suspendPollTimer<T>(store: Store<T>) {
  if (store.pollTimer !== null) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
  store.pollSuspended = true;
}

/** True when any polling subscriber opted out of hidden pausing (e.g. restart watch). */
function anyOptOut<T>(store: Store<T>): boolean {
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms === "number" && ms > 0 && store.pauseWhenHiddenByListener.get(listener) === false) {
      return true;
    }
  }
  return false;
}

/** True when the document is currently hidden. Safe on non-browser runtimes. */
function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Pick a subscriber whose poll may run right now.
 *
 * While the document is hidden only subscribers that opted out of pausing are eligible:
 * a background tab has no one reading the paint, but a restart-reconnect poll still has
 * to notice the server coming back. When nothing opted out, the tick is skipped entirely.
 */
function pickPollEntry<T>(
  store: Store<T>,
): { owner: () => void; fetcher: (signal: AbortSignal) => Promise<T>; deadlineMs: number | undefined } | null {
  if (!documentIsHidden()) return pickFetcherEntry(store);
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms !== "number" || ms <= 0) continue;
    if (store.pauseWhenHiddenByListener.get(listener) === false) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
    }
  }
  return null;
}

/** Prefer a polling subscriber's fetcher; otherwise any remaining subscriber. */
function pickFetcherEntry<T>(
  store: Store<T>,
): { owner: () => void; fetcher: (signal: AbortSignal) => Promise<T>; deadlineMs: number | undefined } | null {
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms === "number" && ms > 0) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
    }
  }
  for (const [listener, fetcher] of store.fetcherByListener) {
    return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
  }
  return null;
}

/** Honor the most aggressive (smallest positive) poll interval among subscribers. */
function recomputePoll<T>(store: Store<T>) {
  let pollMs: number | undefined;
  for (const ms of store.pollByListener.values()) {
    if (typeof ms === "number" && ms > 0) {
      pollMs = pollMs === undefined ? ms : Math.min(pollMs, ms);
    }
  }
  if (pollMs === undefined) {
    // No subscriber polls any more: full teardown. A suspended store resets here so
    // the next polling subscriber starts clean even while the tab is still hidden —
    // otherwise the flag would outlive the listener that resumes it.
    clearPollTimer(store);
    store.pollSuspended = false;
    removeVisibilityListener(store);
    return;
  }
  // Keep the existing countdown when the effective interval is unchanged.
  if (pollMs === store.pollIntervalMs && store.pollTimer !== null) {
    // Opt-out churn with an unchanged interval: the last opt-out left while hidden —
    // the timer would keep waking every interval with zero eligible entries.
    if (documentIsHidden() && !anyOptOut(store)) suspendPollTimer(store);
    return;
  }
  if (store.pollSuspended) {
    store.pollIntervalMs = pollMs;
    // Hidden with no opt-out: bookkeeping only — arming is the visibility handler's
    // job. An opt-out subscriber joining a suspended store arms below even while
    // hidden: noticing the off-screen event is its documented purpose.
    if (documentIsHidden() && !anyOptOut(store)) return;
    store.pollSuspended = false;
  }
  clearPollTimer(store);
  store.pollIntervalMs = pollMs;
  if (documentIsHidden() && !anyOptOut(store)) {
    // First subscribed (or re-armed) while already hidden: hold no timer at all.
    // The listener still installs so the resume + make-up path stays live.
    store.pollSuspended = true;
    ensureVisibilityListener(store);
    return;
  }
  store.pollTimer = setInterval(() => {
    const entry = pickPollEntry(store);
    if (!entry) return;
    // Skip ticks while a request is in flight so slow polls can finish.
    void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner, deadlineMs: entry.deadlineMs });
  }, pollMs);
  ensureVisibilityListener(store);
}

/**
 * One listener per polling store, installed whenever a polling subscriber exists —
 * regardless of whether a timer is currently armed (a mount-while-hidden store has
 * no timer but MUST still resume). On hidden the timer is suspended outright (zero
 * wakeups, unless an opt-out subscriber keeps it); on visible the skipped ticks are
 * made up with a single quiet revalidation and the cadence re-arms.
 *
 * `replaceInflight: false` keeps this from cancelling work a visible-again mount just
 * started; if something is already loading, that request is the fresh answer.
 */
function ensureVisibilityListener<T>(store: Store<T>) {
  if (typeof document === "undefined" || store.visibilityListener) return;
  const onVisibility = () => {
    if (store.pollIntervalMs === undefined) return;
    if (documentIsHidden()) {
      if (anyOptOut(store)) return; // opt-out polls keep their timer running
      suspendPollTimer(store);
      return;
    }
    if (store.pollSuspended) {
      store.pollSuspended = false;
      recomputePoll(store); // re-arms: pollIntervalMs survived the suspension
    }
    const entry = pickFetcherEntry(store);
    if (!entry) return;
    void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner, deadlineMs: entry.deadlineMs });
  };
  document.addEventListener("visibilitychange", onVisibility);
  store.visibilityListener = onVisibility;
}

function removeVisibilityListener<T>(store: Store<T>) {
  if (!store.visibilityListener) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", store.visibilityListener);
  }
  store.visibilityListener = null;
}

async function runFetch<T>(
  store: Store<T>,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { replaceInflight?: boolean; owner?: (() => void) | null; forceLoading?: boolean; deadlineMs?: number },
) {
  const replaceInflight = options?.replaceInflight !== false;
  if (store.inflight && !replaceInflight) return;

  if (replaceInflight) store.inflight?.abort();
  const controller = new AbortController();
  store.inflight = controller;
  store.inflightOwner = options?.owner ?? null;
  const gen = ++store.generation;

  /**
   * Every attempt has a deadline, enforced two ways at once:
   * - the abort tells well-behaved fetchers to stop (with RESOURCE_TIMEOUT as the
   *   reason, so the settle guard can tell the deadline apart from an owner abort);
   * - the race settles the store even when a fetcher drops the signal entirely.
   * Without the flag, a fallback that aborts the guarded controller would make a
   * timeout indistinguishable from an owner abort and the store would never settle.
   */
  const deadlineMs = options?.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  let timedOut = false;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(RESOURCE_TIMEOUT);
  }, deadlineMs);

  // Falsy cached values stay visible during polls; forceLoading is for identity changes (deps).
  // `refreshing` always rises so a slow revalidation is observable without blanking content.
  const shouldShowLoading = store.snapshot.data === undefined || options?.forceLoading === true;
  store.snapshot = {
    ...store.snapshot,
    loading: shouldShowLoading ? true : store.snapshot.loading,
    refreshing: true,
  };
  emit(store);

  try {
    const data = await Promise.race([
      fetcher(controller.signal),
      new Promise<never>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          if (timedOut) reject(new Error(`resource request timed out after ${deadlineMs}ms`));
          // An owner abort frees the race frame immediately; the success guard below
          // early-returns on signal.aborted, so this never settles data.
          else resolve(null as never);
        }, { once: true });
      }),
    ]);
    if (gen !== store.generation || controller.signal.aborted) return;
    // Cleared on settle (not at subscribe) so StrictMode's aborted first mount still revalidates.
    store.seedNeedsRevalidate = false;
    store.snapshot = {
      data,
      error: undefined,
      loading: false,
      refreshing: false,
      hasSucceeded: true,
      lastAttemptOk: true,
    };
  } catch (error) {
    if (gen !== store.generation) return;
    // Owner aborts (replace/unmount) never settle; only the deadline and real
    // fetcher rejections reach the failure path.
    if (controller.signal.aborted && !timedOut) return;
    store.seedNeedsRevalidate = false;
    store.snapshot = {
      ...store.snapshot,
      // Normalize so a loader that rejects with `undefined` still reads as a failure.
      error: error === undefined ? new Error("resource load failed") : error,
      loading: false,
      refreshing: false,
      lastAttemptOk: false,
    };
  } finally {
    clearTimeout(deadlineTimer);
    if (store.inflight === controller) {
      store.inflight = null;
      store.inflightOwner = null;
    }
    emit(store);
  }
}

function abortInflightOwnedBy<T>(store: Store<T>, owner: () => void): boolean {
  if (store.inflightOwner !== owner) return false;
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  // The aborted request will never reach its own settle path, so clear its progress marker here.
  if (store.snapshot.refreshing) {
    store.snapshot = { ...store.snapshot, refreshing: false };
    emit(store);
  }
  return true;
}

/**
 * Drop the module cache only after a macrotask so React's subscribe teardown +
 * resubscribe (pollMs / enabled / key churn) can reattach in the same turn
 * without wiping cached data.
 */
function scheduleStoreEviction(key: string, store: Store<unknown>) {
  clearPollTimer(store);
  store.pollSuspended = false;
  // The visibility listener exists to wake a poll; with no poll left there is nothing to
  // wake, and leaving it attached would leak one handler per evicted store.
  removeVisibilityListener(store);
  setTimeout(() => {
    if (store.subscriberCount !== 0) return;
    if (stores.get(key) !== store) return;
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
    stores.delete(key);
  }, 0);
}

/** Per-listener registration: one object instead of positional sprawl. */
type ListenerRegistration<T> = {
  fetcher: (signal: AbortSignal) => Promise<T>;
  pollMs?: number;
  pauseWhenHidden?: boolean;
  deadlineMs?: number;
};

function subscribeResource<T>(
  key: string,
  onStoreChange: () => void,
  registration: ListenerRegistration<T>,
) {
  const { fetcher, pollMs, pauseWhenHidden = true, deadlineMs } = registration;
  const store = getStore<T>(key);
  store.listeners.add(onStoreChange);
  store.pollByListener.set(onStoreChange, pollMs);
  store.pauseWhenHiddenByListener.set(onStoreChange, pauseWhenHidden);
  store.fetcherByListener.set(onStoreChange, fetcher);
  store.deadlineByListener.set(onStoreChange, deadlineMs);
  store.subscriberCount++;

  // Cold start, or a pre-subscribe seed that still needs a network check. Keep
  // cached data across transient 0→1 resubscribe gaps when neither applies.
  if (store.subscriberCount === 1) {
    if (store.snapshot.data === undefined || store.seedNeedsRevalidate) {
      void runFetch(store, fetcher, { replaceInflight: true, owner: onStoreChange, deadlineMs });
    }
  }
  recomputePoll(store);

  return () => {
    store.listeners.delete(onStoreChange);
    store.pollByListener.delete(onStoreChange);
    store.pauseWhenHiddenByListener.delete(onStoreChange);
    store.fetcherByListener.delete(onStoreChange);
    store.deadlineByListener.delete(onStoreChange);
    store.subscriberCount--;
    // Drop this subscriber's in-flight work so a late resolve cannot stomp shared data.
    const abortedOwned = abortInflightOwnedBy(store, onStoreChange);
    if (store.subscriberCount === 0) {
      scheduleStoreEviction(key, store);
      return;
    }
    // Replace aborted work immediately so the shared snapshot cannot stay stuck loading.
    if (abortedOwned) {
      const entry = pickFetcherEntry(store);
      if (entry) {
        void runFetch(store, entry.fetcher, { replaceInflight: true, owner: entry.owner, deadlineMs: entry.deadlineMs });
      }
    }
    recomputePoll(store);
  };
}

/** Module-level fetch cache with useSyncExternalStore subscriptions (no fetch in useEffect). */
export interface ClientResourceOptions<T = unknown> {
  pollMs?: number;
  enabled?: boolean;
  /**
   * Whether this subscriber's poll may be skipped while the document is hidden.
   * Defaults to true. Set false for polls whose whole purpose is to notice something
   * happening off-screen — a restarting server, for instance.
   */
  pauseWhenHidden?: boolean;
  /**
   * Optional seed applied once before the first subscribe (session-cache revisit).
   * Lives in the store — not a render-time ref — so React Compiler / react-hooks/refs
   * stay quiet while the mount fetch still quiet-revalidates via `seedNeedsRevalidate`.
   */
  initialData?: T;
  /**
   * Per-attempt deadline override. Default DEFAULT_REQUEST_DEADLINE_MS (30s). Raise it
   * for endpoints documented as slow; a timed-out attempt settles failed instead of
   * wedging the store.
   */
  deadlineMs?: number;
}

/** Seed an empty, unsubscribed store. No-ops when data already exists or someone is listening. */
function seedClientResourceIfEmpty<T>(key: string, data: T): void {
  const store = getStore<T>(key);
  if (store.subscriberCount !== 0 || store.snapshot.data !== undefined) return;
  setClientResourceData(key, data);
}

export function useClientResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: ClientResourceOptions<T>,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const enabled = options?.enabled !== false;
  const pollMs = options?.pollMs;
  // Default true: a background tab has nobody reading the paint. Opt out for polls that
  // must keep running while hidden, such as waiting for a restarted server to answer.
  const pauseWhenHidden = options?.pauseWhenHidden !== false;
  const deadlineMs = options?.deadlineMs;
  if (enabled && options?.initialData !== undefined) {
    seedClientResourceIfEmpty(key, options.initialData);
  }
  const fetcherRef = useRef(fetcher);
  // Sync latest fetcher every commit. No dep array on purpose: inline fetchers are
  // reallocated every render; listing them would re-subscribe forever.
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const stableFetcher = useCallback(
    (signal: AbortSignal) => fetcherRef.current(signal),
    [],
  );

  const listenerRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      listenerRef.current = onStoreChange;
      return subscribeResource(key, onStoreChange, { fetcher: stableFetcher, pollMs, pauseWhenHidden, deadlineMs });
    },
    [key, stableFetcher, pollMs, enabled, pauseWhenHidden, deadlineMs],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!enabled) return EMPTY_SNAPSHOT;
    return getStore<T>(key).snapshot;
  }, [key, enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback((opts?: { forceLoading?: boolean }) => {
    if (!enabled) return;
    const store = getStore<T>(key);
    void runFetch(store, stableFetcher, {
      replaceInflight: true,
      owner: listenerRef.current,
      forceLoading: opts?.forceLoading,
      // The refreshing listener's own deadline — not a frozen option — so a shared
      // key keeps each owner's contract.
      deadlineMs: listenerRef.current ? store.deadlineByListener.get(listenerRef.current) : deadlineMs,
    });
  }, [key, stableFetcher, enabled, deadlineMs]);

  return { ...snapshot, refresh };
}

function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  if (prev === null) return false;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Like `useClientResource`, but refetches when `deps` change (element-wise
 * `Object.is`), even if the cache `key` stays the same. Callers may allocate a
 * fresh deps array each render — identity of the array is ignored.
 * Deps changes force `loading: true` while retaining previous data until the
 * new response arrives (unlike quiet poll refreshes).
 */
export function useKeyedClientResource<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: ClientResourceOptions<T>,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const resource = useClientResource(key, load, options);
  const prevDepsRef = useRef<readonly unknown[] | null>(null);
  const prevKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = prevDepsRef.current;
    const prevKey = prevKeyRef.current;
    prevDepsRef.current = deps;
    prevKeyRef.current = key;
    if (!depsChanged(prev, deps)) return;
    // When the key moved with the deps, subscribing to the new key already started a cold fetch.
    // Revalidating here as well would double every request on a keyed identity change.
    if (prevKey !== null && prevKey !== key) return;
    resource.refresh({ forceLoading: true });
  });

  return resource;
}

/** Publish data for a key and invalidate any in-flight fetch so it cannot stomp this write. */
export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  store.snapshot = {
    data,
    error: undefined,
    loading: false,
    refreshing: false,
    hasSucceeded: true,
    lastAttemptOk: true,
  };
  // Only pre-subscribe seeds need a follow-up fetch. Live publishers (mutation
  // results) already hold the fresh value and must not schedule a redundant GET.
  store.seedNeedsRevalidate = store.subscriberCount === 0;
  emit(store);
}

/** Test-only: drop every module cache entry so suite order cannot skip cold-start fetches. */
export function clearClientResourceStoresForTests(): void {
  for (const store of stores.values()) {
    clearPollTimer(store);
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
  }
  stores.clear();
}

/**
 * Test-only: whether a live poll timer exists for the key. Suspension (hidden with no
 * opt-out subscriber) means NO timer — that absence is the whole hidden-tab guarantee,
 * and fetch counts alone cannot see it (skipped ticks look identical).
 */
export function hasPollTimerForTests(key: string): boolean {
  const store = stores.get(key);
  return store ? store.pollTimer !== null : false;
}
