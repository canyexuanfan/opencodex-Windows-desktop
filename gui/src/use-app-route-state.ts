import { useEffect, useState } from "react";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
  type Page,
} from "./app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "./hash-routing";
import {
  ensureMigratedViewMode,
  providersHashForGlobalViewChange,
  providersHashForViewMode,
  readViewMode,
  toggleViewMode,
  writeViewMode,
  type ViewMode,
} from "./view-mode";

/**
 * Production App route + Classic/Workspace ownership.
 * Hash page changes push history; view-mode sync on Providers replaces the current entry.
 */
export function useAppRouteState() {
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const migrated = ensureMigratedViewMode();
    try {
      const rawHash = normalizeHashPath(window.location.hash);
      if (rawHash === "providers/workspace") {
        writeViewMode("workspace");
        return "workspace";
      }
    } catch {
      /* ignore */
    }
    return migrated;
  });

  const applyHashAction = (rawHash: string) => {
    const action = resolveAppHashChange(rawHash, readViewMode());
    if (action.replaceTo) replaceHash(action.replaceTo);
    if (action.persistViewMode) writeViewMode(action.persistViewMode);
    // Route page and view mode update in the same event — never via startTransition.
    setPageState(action.page);
    if (action.viewMode) setViewMode(action.viewMode);
  };

  const toggleGlobalWorkspace = () => {
    const next = toggleViewMode(viewMode);
    writeViewMode(next);
    setViewMode(next);
    // Preference change, not page navigation: replace the Providers hash in place.
    const wanted = providersHashForGlobalViewChange(window.location.hash, next, page === "providers");
    if (wanted) replaceHash(wanted);
  };

  const navigateToPage = (id: Page) => {
    navigateHash(id === "providers" ? providersHashForViewMode(readViewMode()) : id);
    setPageState(id);
  };

  useEffect(() => {
    const onRouteHash = () => {
      applyHashAction(normalizeHashPath(window.location.hash));
    };
    // hashchange covers location.hash assignment; popstate covers Back/Forward.
    window.addEventListener("hashchange", onRouteHash);
    window.addEventListener("popstate", onRouteHash);
    return () => {
      window.removeEventListener("hashchange", onRouteHash);
      window.removeEventListener("popstate", onRouteHash);
    };
  }, []);

  useEffect(() => {
    const rawHash = normalizeHashPath(window.location.hash);
    if (rawHash === "debug" || rawHash.startsWith("debug/")) {
      replaceHash("logs/debug");
      return;
    }
    if (page === "providers") {
      const wanted = providersHashForViewMode(viewMode);
      if (rawHash !== wanted) replaceHash(wanted);
      return;
    }
    if (!hashBelongsToPage(rawHash, page)) {
      replaceHash(page);
    }
  }, [page, viewMode]);

  return {
    page,
    viewMode,
    setPageState,
    toggleGlobalWorkspace,
    navigateToPage,
  };
}
