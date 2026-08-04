import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";

import {
  beginCodexTransition,
  openCodexCoordinatorTransaction,
  readCodexTransitionState,
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
