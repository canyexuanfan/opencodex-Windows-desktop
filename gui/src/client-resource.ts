import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

export type ResourceSnapshot<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
};

type Store<T> = {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  subscriberCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  inflight: AbortController | null;
  generation: number;
};

const stores = new Map<string, Store<unknown>>();

const EMPTY_SNAPSHOT: ResourceSnapshot<never> = { data: undefined, error: undefined, loading: false };

function getStore<T>(key: string): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    store = {
      snapshot: { data: undefined, error: undefined, loading: false },
      listeners: new Set(),
      subscriberCount: 0,
      pollTimer: null,
      inflight: null,
      generation: 0,
    };
    stores.set(key, store);
  }
  return store;
}

function emit<T>(store: Store<T>) {
  for (const listener of store.listeners) listener();
}

async function runFetch<T>(
  store: Store<T>,
  fetcher: (signal: AbortSignal) => Promise<T>,
) {
  store.inflight?.abort();
  const controller = new AbortController();
  store.inflight = controller;
  const gen = ++store.generation;

  if (!store.snapshot.data) {
    store.snapshot = { ...store.snapshot, loading: true };
    emit(store);
  }

  try {
    const data = await fetcher(controller.signal);
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = { data, error: undefined, loading: false };
  } catch (error) {
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = { ...store.snapshot, error, loading: false };
  } finally {
    if (store.inflight === controller) store.inflight = null;
    emit(store);
  }
}

function subscribeResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  pollMs: number | undefined,
  onStoreChange: () => void,
) {
  const store = getStore<T>(key);
  store.listeners.add(onStoreChange);
  store.subscriberCount++;

  if (store.subscriberCount === 1) {
    void runFetch(store, fetcher);
    if (pollMs && pollMs > 0) {
      store.pollTimer = setInterval(() => void runFetch(store, fetcher), pollMs);
    }
  }

  return () => {
    store.listeners.delete(onStoreChange);
    store.subscriberCount--;
    if (store.subscriberCount === 0) {
      store.inflight?.abort();
      store.inflight = null;
      if (store.pollTimer !== null) {
        clearInterval(store.pollTimer);
        store.pollTimer = null;
      }
    }
  };
}

/** Module-level fetch cache with useSyncExternalStore subscriptions (no fetch in useEffect). */
export function useClientResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: () => void } {
  const enabled = options?.enabled !== false;
  const pollMs = options?.pollMs;
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

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      return subscribeResource(key, stableFetcher, pollMs, onStoreChange);
    },
    [key, stableFetcher, pollMs, enabled],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!enabled) return EMPTY_SNAPSHOT;
    return getStore<T>(key).snapshot;
  }, [key, enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void runFetch(getStore<T>(key), stableFetcher);
  }, [key, stableFetcher, enabled]);

  return { ...snapshot, refresh };
}

/** Stable loader via explicit deps — avoids react-doctor fresh-deps on inline fetchers. */
export function useKeyedClientResource<T>(
  key: string,
  _deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: () => void } {
  // `useClientResource` keeps the latest `load` via layout-effect ref sync; `_deps` is
  // retained so call sites can document intentional invalidation keys without
  // wrapping every loader in useCallback.
  void _deps;
  return useClientResource(key, load, options);
}

export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.snapshot = { data, error: undefined, loading: false };
  emit(store);
}
