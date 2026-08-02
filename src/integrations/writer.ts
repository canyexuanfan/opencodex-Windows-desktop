/**
 * Apply, disable and restore an opencodex provider block in a client's config.
 *
 * Everything here exists to keep one promise: a toggle can always be undone.
 * That means every mutation snapshots first, writes atomically, and journals
 * what it did — and that a mutation refuses rather than guesses whenever the
 * file is not in a state we can reason about. A disable that deletes work the
 * user did after us would be worse than never shipping the feature.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/030 and 031.
 */
import { dirname } from "node:path";
import { EXPORT_CLIENTS, type ExportModel } from "../clients/config-export";
import { isLoopbackHostname } from "../codex/inject";
import type { OcxConfig } from "../types";
import { PARSE_FAILED, defaultIntegrationIO, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { fingerprint, canonicalContribution, fragmentPathsOf, type OwnershipRecord } from "./ownership";
import { createdContainerPaths, mergeContribution, removeFragments } from "./merge";
import { INTEGRATION_CLIENTS, isLoopbackOnly, type IntegrationClientId } from "./registry";
import { classifyIntegration, exportContextOf } from "./state";
import type { IntegrationState } from "./state";
import { serializeDocument } from "./serialize";
import { newOpId, type JournalEntry } from "./journal";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";

export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export interface WriteOk {
  ok: true;
  changed: boolean;
  state: IntegrationState;
  clientId: IntegrationClientId;
  opId?: string;
  message: string;
}

export interface WriteRefused {
  ok: false;
  reason: RefusalReason;
  state: IntegrationState;
  clientId: IntegrationClientId;
  message: string;
  /** Absolute path of a recoverable snapshot, when one exists. */
  snapshotPath?: string;
  /** True when compensation itself failed and the file is intermediate. */
  residual?: boolean;
}

export type WriteOutcome = WriteOk | WriteRefused;

export interface IntegrationWriteInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: IntegrationStateStore;
  io?: IntegrationIO;
}

export interface IntegrationRestoreInput extends IntegrationWriteInput {
  opId: string;
  confirmDrift?: boolean;
}

function refuse(
  clientId: IntegrationClientId,
  reason: RefusalReason,
  state: IntegrationState,
  message: string,
  snapshotPath?: string,
): WriteRefused {
  return { ok: false, reason, state, clientId, message, ...(snapshotPath ? { snapshotPath } : {}) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CommitArgs {
  io: IntegrationIO;
  store: IntegrationStateStore;
  clientId: IntegrationClientId;
  configPath: string;
  before: string | null;
  nextText: string | null;
  record: OwnershipRecord | null;
  priorRecord: OwnershipRecord | null;
  entry: JournalEntry;
  state: IntegrationState;
  snapshotPath?: string;
}

/**
 * Client file, then ownership record, then journal row.
 *
 * The row is last on purpose: a record without a row is a thin history, while
 * a row without a record would advertise an operation the classifier cannot
 * corroborate. If either bookkeeping step fails we put the file back AND
 * restore the ownership the operation replaced.
 */
function commit(args: CommitArgs): WriteOutcome {
  const { io, clientId, configPath } = args;
  try {
    if (args.nextText === null) io.removeFile(configPath);
    else {
      io.mkdirp(dirname(configPath));
      io.writeText(configPath, args.nextText);
    }
  } catch (error) {
    return refuse(clientId, "write_failed", args.state, messageOf(error), args.snapshotPath);
  }
  try {
    if (args.record) io.putRecord(args.record);
    else io.dropRecord(clientId);
  } catch (error) {
    return compensate(args, error, "could not record ownership");
  }
  try {
    io.appendJournal(args.entry);
  } catch (error) {
    return compensate(args, error, "could not append the journal row");
  }
  return {
    ok: true,
    changed: true,
    state: args.state,
    clientId,
    opId: args.entry.opId,
    message: "ok",
  };
}

function compensate(args: CommitArgs, cause: unknown, what: string): WriteRefused {
  const { io, clientId, configPath } = args;
  try {
    if (args.before === null) io.removeFile(configPath);
    else io.writeText(configPath, args.before);
    if (args.priorRecord) io.putRecord(args.priorRecord);
    else io.dropRecord(clientId);
  } catch {
    // Say so. A false "rolled back" is worse than the original error, because
    // the user would stop looking for the file we left half-written.
    return {
      ok: false,
      reason: "write_failed",
      state: args.state,
      clientId,
      residual: true,
      ...(args.snapshotPath ? { snapshotPath: args.snapshotPath } : {}),
      message: `${what}, and the change could not be rolled back. The file or its ownership record is in an intermediate state; the backup is at ${args.snapshotPath ?? "(none)"}.`,
    };
  }
  return refuse(clientId, "write_failed", args.state, `${what}; the change was rolled back. Cause: ${messageOf(cause)}`, args.snapshotPath);
}

function snapshotAbsPath(store: IntegrationStateStore, entry: JournalEntry): string | undefined {
  const snapshot = store.readSnapshot(entry);
  return snapshot.kind === "stored" ? snapshot.path : undefined;
}

/** Shared preflight: detect, gate, read, parse and classify. */
function preflight(input: IntegrationWriteInput) {
  const store = input.store ?? createIntegrationStateStore();
  const io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  const configPath = spec.configPath(input.env, input.home);
  store.retryPendingPrunes();

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      failed: refuse(clientId, "unsafe", "unsafe",
        target.why === "read-failed"
          ? `${configPath} exists but could not be read`
          : `${configPath} is not a regular file`),
    } as const;
  }
  const before = target.before;
  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return { failed: refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`) } as const;
  }
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  // A record proves ownership of the file it was written FOR. Matching only by
  // client id let a record for one home authorize a write to another whose
  // bytes happened to hash the same — which deleted a config we never touched.
  const stored = store.readRecords()[clientId] ?? null;
  const record = stored && stored.clientId === clientId && stored.configPath === configPath
    ? stored
    : null;
  // `configPath`/`clientId` are load-bearing, not decoration: a record proves
  // ownership of ONE file, and the writer mutates whatever path resolves NOW.
  // Without them a record written for another home directory would grant
  // ownership here and disable would delete fragments it never wrote.
  const classified = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution, configPath, clientId,
  });
  return { failed: undefined, store, io, clientId, spec, exportSpec, configPath, before, parsed, contribution, record, classified } as const;
}

export function applyIntegration(input: IntegrationWriteInput): WriteOutcome {
  const pre = preflight(input);
  if (pre.failed) return pre.failed;
  const { store, io, clientId, spec, exportSpec, configPath, before, parsed, contribution, record, classified } = pre;

  if (io.statKind(spec.detectDir(input.env, input.home)) !== "dir") {
    return refuse(clientId, "not_installed", "absent", `${clientId} is not installed`);
  }
  if (isLoopbackOnly(clientId) && !isLoopbackHostname(input.config.hostname)) {
    return refuse(clientId, "non_loopback", classified.state,
      `${clientId} has nowhere to put the admission header a non-loopback bind requires, so a generated config would be rejected. Configure it by hand instead.`);
  }
  if (classified.state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      classified.reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it`
        : `${configPath} already contains an opencodex block we did not write`);
  }
  if (classified.state === "current") {
    return { ok: true, changed: false, state: "current", clientId, message: "already applied" };
  }

  // A stale refresh drops what the PREVIOUS record owned before merging: a
  // model that left the catalog would otherwise stay behind as an orphan the
  // new record no longer covers, and disable could never remove it.
  const base = classified.state === "stale" && record
    ? removeFragments(parsed, record.fragmentPaths).doc
    : parsed;
  // Computed against the document as it stands BEFORE the merge: afterwards
  // every container exists and "did we create this?" is unanswerable.
  const created = createdContainerPaths(base, contribution);
  const text = serializeDocument(mergeContribution(base, contribution), exportSpec.format);

  // Compare-before-commit: someone may have written between classify and now.
  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while applying`);
  }

  const opId = newOpId();
  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  const entry: JournalEntry = {
    opId, clientId, kind: classified.state === "stale" ? "refresh" : "apply", at, configPath,
    snapshot, resultFingerprint: fingerprint(text), resultAbsent: false, priorRecord: record,
  };
  return commit({
    io, store, clientId, configPath, before, nextText: text, state: "current",
    priorRecord: record,
    record: {
      clientId, configPath, fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(contribution)),
      fragmentPaths: fragmentPathsOf(contribution), createdContainers: created,
      appliedAt: at, opId,
    },
    entry,
    snapshotPath: snapshotAbsPath(store, entry),
  });
}

export function disableIntegration(input: IntegrationWriteInput): WriteOutcome {
  const pre = preflight(input);
  if (pre.failed) return pre.failed;
  const { store, io, clientId, exportSpec, configPath, before, parsed, record, classified } = pre;

  if (classified.state === "absent") {
    return { ok: true, changed: false, state: "absent", clientId, message: "not applied" };
  }
  if (classified.state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      classified.reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it; disabling would discard that edit`
        : `${configPath} contains an opencodex block we did not write`);
  }

  // current | stale only: the file fingerprint still matches our record, so the
  // recorded paths are exactly what we put there.
  const { doc, removed } = removeFragments(
    parsed,
    record!.fragmentPaths,
    new Set(record!.createdContainers ?? []),
  );
  if (!removed) {
    return { ok: true, changed: false, state: "absent", clientId, message: "nothing to remove" };
  }
  const text = serializeDocument(doc, exportSpec.format);

  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while disabling`);
  }

  const opId = newOpId();
  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  const entry: JournalEntry = {
    opId, clientId, kind: "disable", at, configPath, snapshot,
    resultFingerprint: fingerprint(text), resultAbsent: false, priorRecord: record,
  };
  return commit({
    io, store, clientId, configPath, before, nextText: text, state: "absent",
    record: null, priorRecord: record, entry,
    snapshotPath: snapshotAbsPath(store, entry),
  });
}

export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome {
  const store = input.store ?? createIntegrationStateStore();
  const io = input.io ?? defaultIntegrationIO(store);
  const entry = store.findOperation(input.opId);
  if (!entry) throw new Error(`unknown operation ${input.opId}`);
  if (entry.clientId !== input.clientId) throw new Error("restore input names a different client than the operation");

  const clientId = entry.clientId;
  const resolvedPath = INTEGRATION_CLIENTS[clientId].configPath(input.env, input.home);
  // Restore acts on the path the operation was journaled against. Resolving a
  // different path here would let an operation recorded for one home delete a
  // file in another.
  const configPath = entry.configPath;
  if (resolvedPath !== configPath) {
    return refuse(clientId, "conflict", "conflict",
      `that operation was recorded for ${configPath}, but this client now resolves to ${resolvedPath}`);
  }
  const snapshot = store.readSnapshot(entry);
  if (snapshot.kind === "expired") {
    return refuse(clientId, "snapshot_expired", "absent", "that backup has expired");
  }
  const backupHint = snapshot.kind === "stored" ? snapshot.path : undefined;

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read; the backup is at ${backupHint ?? "(none)"}`
        : `${configPath} is not a regular file; the backup is at ${backupHint ?? "(none)"}`,
      backupHint);
  }
  const current = target.before;

  // Drift: the file changed after the operation we are undoing.
  if (fingerprint(current ?? "") !== entry.resultFingerprint && !input.confirmDrift) {
    return refuse(clientId, "drift_requires_confirm", "conflict",
      "this file changed after that operation; confirm to replace it (the current version is backed up first)");
  }

  // Restore is itself journaled and itself undoable: snapshot the CURRENT file
  // first, so a confirmed drift-restore never destroys the newer edits.
  const opId = newOpId();
  const preSnapshot = store.captureSnapshot(clientId, opId, current);
  const restoredText = snapshot.kind === "none" ? null : snapshot.text;

  // Provenance is RESTORED, never re-derived: `priorRecord` described these
  // exact bytes when the snapshot was taken. Re-deriving it from the file would
  // mean guessing which entries are ours, and a wrong guess deletes a user's.
  const restoredRecord = entry.priorRecord;
  const fresh = EXPORT_CLIENTS[clientId].buildContribution(exportContextOf(input));
  const state: IntegrationState = restoredRecord === null
    ? (restoredText === null ? "absent" : "conflict")
    : restoredRecord.blockFingerprint === fingerprint(canonicalContribution(fresh))
      ? "current"
      : "stale";

  const at = new Date(io.now()).toISOString();
  const priorRecord = store.readRecords()[clientId] ?? null;
  const restoreEntry: JournalEntry = {
    opId, clientId, kind: "restore", at, configPath, snapshot: preSnapshot,
    resultFingerprint: restoredText === null ? "" : fingerprint(restoredText),
    resultAbsent: restoredText === null,
    priorRecord,
  };
  return commit({
    io, store, clientId, configPath, before: current, nextText: restoredText, state,
    priorRecord,
    record: restoredRecord === null ? null : {
      ...restoredRecord,
      fileFingerprint: restoredText === null ? "" : fingerprint(restoredText),
      appliedAt: at,
      opId,
    },
    entry: restoreEntry,
    snapshotPath: snapshotAbsPath(store, restoreEntry),
  });
}
