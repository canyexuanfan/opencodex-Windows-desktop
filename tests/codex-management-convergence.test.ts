import { expect, test } from "bun:test";

import { createManagementConvergeCodex } from "../src/codex/management-convergence";
import type { ConvergeRequest } from "../src/codex/convergence-types";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai" };
}

function request(scope: ConvergeRequest["scope"]): ConvergeRequest {
  return {
    action: "converge",
    scope,
    reason: "management-mutation",
    mode: "automatic",
    deadlineMs: 1_000,
  };
}

test("returns an honest catalog-only no-change projection", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  const outcome = await convergeCodex(request("catalog"));

  expect(outcome).toEqual({
    kind: "catalog-only",
    changed: false,
    catalogRefresh: { status: "skipped", reason: "not-requested", retryable: false },
    history: {
      status: "not-evaluated",
      attempts: 0,
      nextRetryAt: null,
      txId: null,
      pendingRows: null,
      backupEntries: null,
    },
    observed: {
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
          state: {
            status: "not-evaluated",
            attempts: 0,
            nextRetryAt: null,
            txId: null,
            pendingRows: null,
            backupEntries: null,
          },
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
    },
  });
});

test("rejects a non-catalog request instead of widening management authority", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  await expect(convergeCodex(request("full"))).rejects.toThrow(
    "Management Codex convergence accepts only catalog-scoped requests.",
  );
});
