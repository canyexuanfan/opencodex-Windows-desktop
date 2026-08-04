/**
 * Management-scoped projection before WP9 installs real catalog convergence.
 *
 * The r2 #1 callback swallowed every catalog failure and accepted only the
 * management context's resident config. Keeping that exact object in this
 * factory prevents callers from adding substitute authority to ConvergeRequest.
 * Until WP9 supplies gather/commit, the catalog disposition says no work ran.
 */
import type { OcxConfig } from "../types";
import type {
  CatalogDisposition,
  CatalogOnlyOutcome,
  CodexHistoryState,
  CodexObservedState,
  ConvergeCodex,
  ProjectCatalogOnlyOutcomeInput,
} from "./convergence-types";

function notEvaluatedHistory(): CodexHistoryState {
  return {
    status: "not-evaluated",
    attempts: 0,
    nextRetryAt: null,
    txId: null,
    pendingRows: null,
    backupEntries: null,
  };
}

function notEvaluatedObserved(history: CodexHistoryState): CodexObservedState {
  return {
    aggregate: "not-evaluated",
    isApplied: null,
    desired: "unknown",
    converged: null,
    authority: { service: "unknown", externalProvider: null },
    surfaces: {
      config: "not-evaluated",
      profile: "not-evaluated",
      catalog: "not-evaluated",
      cache: "not-evaluated",
      journal: "not-evaluated",
      history: {
        state: history,
        database: "not-evaluated",
        manifest: "not-evaluated",
        rollouts: "not-evaluated",
      },
      provenance: {
        state: "not-evaluated",
        nativeGeneration: null,
        currentTxId: null,
      },
    },
  };
}

function catalogNotRequested(): CatalogDisposition {
  return { status: "skipped", reason: "not-requested", retryable: false };
}

/** Project catalog work into the shared no-change/not-evaluated outcome shape. */
export function projectCatalogOnlyOutcome({
  changed,
  catalogRefresh,
}: ProjectCatalogOnlyOutcomeInput): CatalogOnlyOutcome {
  const history = notEvaluatedHistory();
  return {
    kind: "catalog-only",
    changed,
    observed: notEvaluatedObserved(history),
    catalogRefresh,
    history,
  };
}

/**
 * Bind the management callback's exact config authority to a catalog-only
 * funnel. This module is intentionally not re-exported by a public Codex facade.
 */
export function createManagementConvergeCodex(
  config: Readonly<OcxConfig>,
): ConvergeCodex {
  const retainedConfig = config;
  return async request => {
    if (request.scope !== "catalog") {
      throw new Error("Management Codex convergence accepts only catalog-scoped requests.");
    }

    // WP9 replaces this no-work projection and consumes this exact reference.
    void retainedConfig;
    return projectCatalogOnlyOutcome({
      changed: false,
      catalogRefresh: catalogNotRequested(),
    });
  };
}
