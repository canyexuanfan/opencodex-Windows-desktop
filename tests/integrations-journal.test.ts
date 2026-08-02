import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_RETENTION, type JournalEntry } from "../src/integrations/journal";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";

/** Activation coverage for devlog/_plan/260802_client_toggle_api/021 §6. */
let root: string;
let store: IntegrationStateStore;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "ocx-integrations-journal-")), "integrations");
  store = createIntegrationStateStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    opId: `op-${Math.random().toString(36).slice(2, 10)}`,
    clientId: "pi",
    kind: "apply",
    at: new Date().toISOString(),
    configPath: "/home/dev/.pi/agent/models.json",
    snapshot: { kind: "none" },
    resultFingerprint: "abc123",
    resultAbsent: false,
    priorRecord: null,
    ...overrides,
  };
}

describe("append and read back", () => {
  test("rows come back newest first", () => {
    const first = entry({ opId: "first" });
    const second = entry({ opId: "second" });
    store.appendJournal(first);
    store.appendJournal(second);
    expect(store.listOperations().map(row => row.opId)).toEqual(["second", "first"]);
  });

  test("a torn final line is skipped, not thrown", () => {
    store.appendJournal(entry({ opId: "intact" }));
    // Simulate a crash mid-append.
    appendFileSync(join(root, "journal.jsonl"), '{"opId":"torn","clientI');
    expect(store.listOperations().map(row => row.opId)).toEqual(["intact"]);
  });

  test("filtering by client leaves other clients' rows alone", () => {
    store.appendJournal(entry({ opId: "pi-op", clientId: "pi" }));
    store.appendJournal(entry({ opId: "kimi-op", clientId: "kimi" }));
    expect(store.listOperations("kimi").map(row => row.opId)).toEqual(["kimi-op"]);
    expect(store.findOperation("pi-op")?.clientId).toBe("pi");
    expect(store.findOperation("absent-op")).toBeNull();
  });
});

describe("snapshots", () => {
  test("a missing file records `none`, which is not a failure", () => {
    const ref = store.captureSnapshot("pi", "op-1", null);
    expect(ref).toEqual({ kind: "none" });
    expect(store.readSnapshot(entry({ snapshot: ref }))).toEqual({ kind: "none" });
  });

  test("stored snapshots read back verbatim", () => {
    const ref = store.captureSnapshot("pi", "op-1", "original bytes\n");
    const read = store.readSnapshot(entry({ opId: "op-1", snapshot: ref }));
    expect(read.kind).toBe("stored");
    if (read.kind === "stored") expect(read.text).toBe("original bytes\n");
  });

  test("retention prunes files but never rows", () => {
    const opIds: string[] = [];
    for (let index = 0; index < SNAPSHOT_RETENTION + 1; index += 1) {
      const opId = `op-${index}`;
      opIds.push(opId);
      const snapshot = store.captureSnapshot("pi", opId, `bytes ${index}\n`);
      store.appendJournal(entry({ opId, snapshot }));
    }
    // Every row survives as history.
    expect(store.listOperations("pi", Number.MAX_SAFE_INTEGER)).toHaveLength(SNAPSHOT_RETENTION + 1);
    // The oldest snapshot's bytes are gone, and it reads as expired rather than
    // as "the file did not exist" — the distinction restore depends on.
    const oldest = store.findOperation(opIds[0]!)!;
    expect(store.readSnapshot(oldest)).toEqual({ kind: "expired" });
    expect(readdirSync(join(root, "snapshots", "pi"))).toHaveLength(SNAPSHOT_RETENTION);
  });

  test("counting distinguishes a genuine zero from an uninspectable directory", () => {
    expect(store.countSnapshots("pi")).toBe(0);
    store.captureSnapshot("pi", "op-1", "bytes\n");
    expect(store.countSnapshots("pi")).toBe(1);
  });
});

describe("maintenance marker", () => {
  test("a malformed marker cannot make a committed append look like a failure", () => {
    mkdirSync(root, { recursive: true });
    // `{}` parses fine but has no pruneFailures — a cast would leave it
    // undefined and the next mark/clear would throw AFTER the row committed.
    writeFileSync(join(root, "maintenance.json"), "{}\n");
    expect(() => store.appendJournal(entry({ opId: "committed" }))).not.toThrow();
    expect(store.findOperation("committed")).not.toBeNull();
    expect(store.readMaintenance()).toEqual({ pruneFailures: {} });
  });

  test("unknown clients and malformed entries are dropped, not trusted", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "maintenance.json"), JSON.stringify({
      pruneFailures: {
        pi: { at: "2026-08-02T00:00:00.000Z", error: "boom" },
        "not-a-client": { at: "x", error: "y" },
        kimi: { at: 42 },
      },
    }));
    expect(store.readMaintenance().pruneFailures).toEqual({
      pi: { at: "2026-08-02T00:00:00.000Z", error: "boom" },
    });
  });

  test("marking and clearing round-trip through the store's own root", () => {
    store.markPruneFailure("pi", "rmSync exploded");
    expect(store.readMaintenance().pruneFailures.pi?.error).toBe("rmSync exploded");
    store.clearPruneFailure("pi");
    expect(store.readMaintenance().pruneFailures.pi).toBeUndefined();
  });

  test("a pending failure is retried and cleared once pruning succeeds", () => {
    store.markPruneFailure("pi", "transient");
    store.retryPendingPrunes();
    expect(store.readMaintenance().pruneFailures.pi).toBeUndefined();
  });
});

describe("store isolation", () => {
  test("everything a store writes stays under its own root", () => {
    const other = join(mkdtempSync(join(tmpdir(), "ocx-other-")), "integrations");
    try {
      const otherStore = createIntegrationStateStore(other);
      otherStore.appendJournal(entry({ opId: "elsewhere" }));
      otherStore.captureSnapshot("pi", "elsewhere", "bytes\n");
      otherStore.markPruneFailure("pi", "boom");

      // Nothing leaked into the first store.
      expect(store.listOperations()).toEqual([]);
      expect(store.readMaintenance()).toEqual({ pruneFailures: {} });
      expect(existsSync(join(root, "snapshots", "pi", "elsewhere"))).toBe(false);
      // And the other store really did do the work.
      expect(otherStore.findOperation("elsewhere")).not.toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
