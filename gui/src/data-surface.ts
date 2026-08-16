/**
 * Render-state classification for data surfaces (WP2 / 010_loading_contract.md).
 *
 * Request ownership stays in `client-resource`; this module only translates a store snapshot
 * into the three decisions a page actually makes: replace the content with a skeleton, show
 * progress next to existing content, or show a failure. Pages used to answer those questions
 * with per-page booleans, which is why a slow load could look identical to an empty result.
 */

import { type ResourceSnapshot, useKeyedClientResource } from "./client-resource";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "./session-list-cache";

export type DataSurfaceKind =
  | "disabled"
  | "cold"
  | "retrying-cold"
  | "loading-with-stale-data"
  | "ready-empty"
  | "ready-populated"
  | "failed-cold"
  | "failed-with-stale";

export type DataSurfaceState<T> = {
  kind: DataSurfaceKind;
  data: T | undefined;
  error: unknown;
  /** True only when the content area should be replaced by a skeleton. */
  showSkeleton: boolean;
  /** True while a request is in flight; drives the inline status line and `aria-busy`. */
  refreshing: boolean;
  /** True when the latest settled attempt failed, so the error banner must stay visible. */
  showError: boolean;
};

export type DataSurfaceResource<T> = ResourceSnapshot<T> & {
  refresh: (opts?: { forceLoading?: boolean }) => void;
  state: DataSurfaceState<T>;
};

export type DataSurfaceOptions<T> = {
  /** The page owns its domain-specific definition of an empty successful payload. */
  isEmpty: (data: T) => boolean;
  pollMs?: number;
  enabled?: boolean;
  /** Forwarded to the resource layer; see ClientResourceOptions.pauseWhenHidden. */
  pauseWhenHidden?: boolean;
  /** Forwarded to the resource layer; see ClientResourceOptions.initialData. */
  initialData?: T;
  /** Forwarded to the resource layer; see ClientResourceOptions.deadlineMs. */
  deadlineMs?: number;
  /** Forwarded to the resource layer; see ClientResourceOptions.staleAfterMs. */
  staleAfterMs?: number;
  /** Forwarded to the resource layer; see ClientResourceOptions.initialDataCachedAt. */
  initialDataCachedAt?: number | null;
  /**
   * Opt-in session-cache wiring: the surface seeds from this key on mount and writes
   * every successful payload back with its timestamp. Pages that already own their
   * cache keep doing it themselves and leave this unset.
   */
  sessionCacheKey?: string;
};

/**
 * Ordering matters: an in-flight request outranks a settled failure so a slow retry keeps
 * showing progress instead of freezing on the previous error.
 */
export function classifyDataSurface<T>(
  snapshot: ResourceSnapshot<T>,
  isEmpty: (data: T) => boolean,
  enabled: boolean,
): DataSurfaceState<T> {
  if (!enabled) {
    return {
      kind: "disabled",
      data: undefined,
      error: undefined,
      showSkeleton: false,
      refreshing: false,
      showError: false,
    };
  }

  const hasData = snapshot.data !== undefined;
  const failed = !snapshot.lastAttemptOk && snapshot.error !== undefined;

  if (snapshot.refreshing) {
    if (hasData) {
      return {
        kind: "loading-with-stale-data",
        data: snapshot.data,
        error: snapshot.error,
        showSkeleton: false,
        refreshing: true,
        showError: failed,
      };
    }
    // No content to keep. A first attempt and a retry both need the skeleton; only the retry
    // carries a prior error, which the caller may surface as non-live secondary text.
    return {
      kind: failed ? "retrying-cold" : "cold",
      data: undefined,
      error: failed ? snapshot.error : undefined,
      showSkeleton: true,
      refreshing: true,
      showError: false,
    };
  }

  if (failed) {
    return hasData
      ? {
          kind: "failed-with-stale",
          data: snapshot.data,
          error: snapshot.error,
          showSkeleton: false,
          refreshing: false,
          showError: true,
        }
      : {
          kind: "failed-cold",
          data: undefined,
          error: snapshot.error,
          showSkeleton: false,
          refreshing: false,
          showError: true,
        };
  }

  if (!hasData) {
    return {
      kind: "cold",
      data: undefined,
      error: undefined,
      showSkeleton: true,
      refreshing: false,
      showError: false,
    };
  }

  return {
    kind: isEmpty(snapshot.data as T) ? "ready-empty" : "ready-populated",
    data: snapshot.data,
    error: undefined,
    showSkeleton: false,
    refreshing: false,
    showError: false,
  };
}

/**
 * Thin adapter over `useKeyedClientResource`: no extra cache, fetch, effect, or timer. All
 * inputs come from the external store snapshot, so every subscriber classifies identically.
 */
export function useDataSurface<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options: DataSurfaceOptions<T>,
): DataSurfaceResource<T> {
  const { isEmpty, sessionCacheKey, ...resourceOptions } = options;
  // Read once per render; sessionStorage is synchronous and the seed only applies
  // while the store is empty, so a repeat read costs nothing and stays in sync.
  const cachedEntry = sessionCacheKey ? readSessionListCacheEntry<T>(sessionCacheKey) : null;
  const loadAndCache = sessionCacheKey
    ? async (signal: AbortSignal): Promise<T> => {
      const next = await load(signal);
      writeSessionListCacheEntry(sessionCacheKey, next);
      return next;
    }
    : load;
  const resource = useKeyedClientResource(key, deps, loadAndCache, {
    ...resourceOptions,
    ...(sessionCacheKey
      ? {
        initialData: resourceOptions.initialData ?? cachedEntry?.data,
        initialDataCachedAt: resourceOptions.initialDataCachedAt ?? cachedEntry?.cachedAt ?? null,
      }
      : {}),
  });
  return {
    ...resource,
    state: classifyDataSurface(resource, isEmpty, options.enabled !== false),
  };
}
