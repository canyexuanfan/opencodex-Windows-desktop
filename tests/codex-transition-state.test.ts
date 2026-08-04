import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";

import {
  beginCodexTransition,
  openCodexCoordinatorTransaction,
  readCodexTransitionState,
  updateCodexHistoryTransition,
} from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-transition-state-codex-home-"));
  process.env.CODEX_HOME = codexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
});

function transition(txId: string) {
  return {
    txId,
    direction: "apply" as const,
    authoritySnapshotId: `authority-${txId}`,
    nextRetryAt: "2026-08-04T12:00:00.000Z",
  };
}

test("a matching conditional transition update succeeds", () => {
  expect(readCodexTransitionState()).toEqual({
    kind: "ready",
    state: {
      nativeGeneration: 0,
      currentTxId: null,
      history: {
        status: "unknown",
        attempts: 0,
        nextRetryAt: null,
        txId: null,
        pendingRows: null,
        backupEntries: null,
      },
      historySchedule: null,
    },
  });

  const result = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-winner"),
  );
  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.state.nativeGeneration).toBe(1);
    expect(result.state.currentTxId).toBe("tx-winner");
    expect(result.state.historySchedule?.direction).toBe("apply");
  }
});

test("an existing database without the singleton row is legacy-ambiguous", () => {
  const database = new Database(coordinatorPath, { create: true });
  database.exec("PRAGMA user_version = 1");
  database.close();
  if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "The existing coordinator database has no authoritative transition row.",
  });
});

test("a zero-row conditional update reports conflict and preserves the winner", () => {
  const winner = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-newer"),
  );
  expect(winner.kind).toBe("updated");

  const stale = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-stale"),
  );
  expect(stale.kind).toBe("conflict");
  if (stale.kind === "conflict") {
    expect(stale.current.currentTxId).toBe("tx-newer");
    expect(stale.current.historySchedule?.authoritySnapshotId).toBe("authority-tx-newer");
  }
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 1, currentTxId: "tx-newer" },
  });
});

test("a positive generation cannot carry a null direction", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-direction"),
  ).kind).toBe("updated");

  const database = new Database(coordinatorPath);
  try {
    expect(() => database.run(
      "UPDATE codex_transition_state SET history_direction = NULL WHERE singleton = 1",
    )).toThrow();
    expect(database.query<{ history_direction: string }, []>(
      "SELECT history_direction FROM codex_transition_state WHERE singleton = 1",
    ).get()?.history_direction).toBe("apply");
  } finally {
    database.close();
  }
});

test("the opaque coordinator capability is one-shot", () => {
  const controller = openCodexCoordinatorTransaction(coordinatorPath);
  try {
    const expectation = controller.expectation();
    const expected = { nativeGeneration: expectation.nativeBefore, currentTxId: null };
    const next = transition(expectation.txId);
    expect(controller.capability.beginTransition(expected, next).kind).toBe("updated");
    expect(() => controller.capability.beginTransition(expected, next))
      .toThrow("already been consumed");
    controller.assertPublished(expectation);
    controller.commit();
  } finally {
    controller.close();
  }
});

/**
 * The C-phase reviewer found this by running the code rather than the suite:
 * `new Database(path, { create: false })` is SQLITE_MISUSE on Bun 1.3.14
 * because the flags name no read mode. Every history update therefore failed
 * before reaching its conditional UPDATE and returned `unavailable/database`,
 * so no terminal history state could ever be recorded.
 *
 * Eighteen tests were green while that was true, because none of them called
 * `updateCodexHistoryTransition` at all. That is the gap this file closes.
 */
test("a history transition update reaches its conditional UPDATE and records terminal state", () => {
  const started = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-history"),
  );
  expect(started.kind).toBe("updated");

  const updated = updateCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-history" },
    {
      status: "converged",
      attempts: 1,
      nextRetryAt: null,
      txId: "tx-history",
      pendingRows: 0,
      backupEntries: 0,
    },
  );

  // Before the fix this was `unavailable` with reason `database`, every time.
  expect(updated.kind).toBe("updated");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.history.status).toBe("converged");
    expect(after.state.history.txId).toBe("tx-history");
    expect(after.state.history.pendingRows).toBe(0);
  }
});

/**
 * The overtaking case the substrate exists for: a stale Worker finishing after
 * a newer transition committed must NOT publish its terminal state over the
 * winner's schedule. It must report conflict.
 */
test("a stale history update conflicts and leaves the newer transition's schedule intact", () => {
  beginCodexTransition({ nativeGeneration: 0, currentTxId: null }, transition("tx-a"));
  const newer = beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    { ...transition("tx-b"), direction: "remove" as const },
  );
  expect(newer.kind).toBe("updated");

  const stale = updateCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    {
      status: "converged",
      attempts: 1,
      nextRetryAt: null,
      txId: "tx-a",
      pendingRows: 0,
      backupEntries: 0,
    },
  );
  expect(stale.kind).toBe("conflict");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.currentTxId).toBe("tx-b");
    expect(after.state.historySchedule?.direction).toBe("remove");
    // The stale worker must not have published its own terminal status.
    expect(after.state.history.status).not.toBe("converged");
  }
});

/**
 * Reviewer finding: the happy-path update test still passed with the
 * conditional WHERE removed, so it did not prove the update is conditional.
 * This one fails the moment the guard stops matching on BOTH columns.
 */
test("a begin whose txId matches but whose generation does not is rejected", () => {
  beginCodexTransition({ nativeGeneration: 0, currentTxId: null }, transition("tx-one"));

  const wrongGeneration = beginCodexTransition(
    { nativeGeneration: 7, currentTxId: "tx-one" },
    transition("tx-two"),
  );
  expect(wrongGeneration.kind).toBe("conflict");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") expect(after.state.currentTxId).toBe("tx-one");
});
