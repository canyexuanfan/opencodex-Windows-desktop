/**
 * One store, bound once.
 *
 * Passing a directory per call was not enough: retention would honor it while
 * records, the journal and snapshots still resolved the global root, so an
 * operation that believed itself isolated could read and mutate the developer's
 * real store. Every method here derives from one `root`, and `io()` binds the
 * bookkeeping seams to that same store so the two can never point at different
 * roots.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/006 §Config-dir seam.
 */
import {
  appendOperation,
  captureSnapshot,
  clearPruneFailure,
  countSnapshots,
  findOperation,
  listOperations,
  markPruneFailure,
  pruneSnapshots,
  readMaintenance,
  readSnapshot,
  type JournalEntry,
  type MaintenanceState,
  type SnapshotRef,
} from "./journal";
import { fileIO, type IntegrationIO } from "./config-io";
import {
  deleteRecord,
  integrationsDir,
  readRecords,
  writeRecord,
  type OwnershipRecord,
} from "./ownership";
import type { IntegrationClientId } from "./registry";

export interface IntegrationStateStore {
  /** The integrations directory itself — never a config root to resolve again. */
  readonly root: string;
  readRecords(): Partial<Record<IntegrationClientId, OwnershipRecord>>;
  putRecord(record: OwnershipRecord): void;
  dropRecord(clientId: IntegrationClientId): void;
  appendJournal(entry: JournalEntry): void;
  listOperations(clientId?: IntegrationClientId, limit?: number): JournalEntry[];
  findOperation(opId: string): JournalEntry | null;
  captureSnapshot(clientId: IntegrationClientId, opId: string, text: string | null): SnapshotRef;
  readSnapshot(entry: JournalEntry):
    | { kind: "none" }
    | { kind: "stored"; text: string; path: string }
    | { kind: "expired" };
  countSnapshots(clientId: IntegrationClientId): number | null;
  pruneSnapshots(clientId: IntegrationClientId): { ok: true } | { ok: false; error: string };
  readMaintenance(): MaintenanceState;
  markPruneFailure(clientId: IntegrationClientId, error: string): void;
  clearPruneFailure(clientId: IntegrationClientId): void;
  retryPendingPrunes(): void;
  /** Filesystem seam with bookkeeping bound to THIS store. */
  io(): IntegrationIO;
}

export function createIntegrationStateStore(root: string = integrationsDir()): IntegrationStateStore {
  const dir = root;
  const store: IntegrationStateStore = {
    root: dir,
    readRecords: () => readRecords(dir),
    putRecord: record => writeRecord(record, dir),
    dropRecord: clientId => deleteRecord(clientId, dir),
    appendJournal: entry => appendOperation(entry, dir),
    listOperations: (clientId, limit) => listOperations(clientId, limit, dir),
    findOperation: opId => findOperation(opId, dir),
    captureSnapshot: (clientId, opId, text) => captureSnapshot(clientId, opId, text, dir),
    readSnapshot: entry => readSnapshot(entry, dir),
    countSnapshots: clientId => countSnapshots(clientId, dir),
    pruneSnapshots: clientId => pruneSnapshots(clientId, dir),
    readMaintenance: () => readMaintenance(dir),
    markPruneFailure: (clientId, error) => markPruneFailure(clientId, error, dir),
    clearPruneFailure: clientId => clearPruneFailure(clientId, dir),
    retryPendingPrunes: () => {
      for (const clientId of Object.keys(store.readMaintenance().pruneFailures) as IntegrationClientId[]) {
        if (store.pruneSnapshots(clientId).ok) store.clearPruneFailure(clientId);
      }
    },
    io: () => ({
      ...fileIO(),
      appendJournal: entry => store.appendJournal(entry),
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    }),
  };
  return store;
}
