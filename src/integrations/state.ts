/**
 * "What is on disk, and did we put it there?"
 *
 * The classifier is deliberately ordered, and the order is load-bearing: an
 * unreadable file can never be reported as absent, and a foreign edit can never
 * be reported as ordinary drift. Getting that wrong would let `disable` delete
 * a user's own edits.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/021 §3.
 */
import { EXPORT_CLIENTS, type ExportModel, type ManagedContribution } from "../clients/config-export";
import type { OcxConfig } from "../types";
import { PARSE_FAILED, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { SNAPSHOT_RETENTION } from "./journal";
import { canonicalContribution, fingerprint, type OwnershipRecord } from "./ownership";
import { INTEGRATION_CLIENTS, type IntegrationClientId } from "./registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";

export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type StateReason = "unparseable" | "not-regular-file" | "foreign-edit" | "unowned-key";

export interface IntegrationStatus {
  clientId: IntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  lastOpId?: string;
  reason?: StateReason;
  /** Snapshot files retained for this client; -1 when they cannot be inspected. */
  snapshotCount: number;
  /** Pruning is behind, so older (possibly credential-bearing) snapshots remain. */
  retentionDegraded: boolean;
}

export function readPath(doc: unknown, path: readonly string[]): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** Does the document carry any fragment we would write? */
export function hasOurFragments(doc: unknown, contribution: ManagedContribution): boolean {
  return contribution.fragments.some(fragment => readPath(doc, fragment.path) !== undefined);
}

/**
 * The two-axis rule: the FILE hash proves nobody touched the file after us, and
 * the BLOCK hash proves our content is still what we would write today.
 */
export function classifyIntegration(input: {
  fileText: string | null;
  fileIsRegular: boolean;
  parsed: unknown | typeof PARSE_FAILED;
  record: OwnershipRecord | null;
  contribution: ManagedContribution;
  /**
   * The file being classified. A record only describes the file it was written
   * for, so this is compared against `record.configPath` before any
   * fingerprint is trusted.
   */
  configPath?: string;
  clientId?: IntegrationClientId;
}): { state: IntegrationState; reason?: StateReason } {
  if (input.fileText !== null && !input.fileIsRegular) {
    return { state: "unsafe", reason: "not-regular-file" };
  }
  if (input.parsed === PARSE_FAILED) return { state: "unsafe", reason: "unparseable" };
  if (!hasOurFragments(input.parsed, input.contribution)) return { state: "absent" };
  if (!input.record) return { state: "conflict", reason: "unowned-key" };
  /*
   * A record proves ownership of ONE file. Change HOME, XDG_CONFIG_HOME,
   * HERMES_HOME or KIMI_CODE_HOME and the same client resolves to a different
   * path — whose contents may hash identically because we generate the same
   * bytes. Trusting the fingerprint alone would let a record for path A grant
   * `current` on path B, and the writer resolves the CURRENT path, so disable
   * would then delete fragments from a file this record never owned.
   */
  if (input.clientId !== undefined && input.record.clientId !== input.clientId) {
    return { state: "conflict", reason: "unowned-key" };
  }
  if (input.configPath !== undefined && input.record.configPath !== input.configPath) {
    return { state: "conflict", reason: "unowned-key" };
  }
  if (fingerprint(input.fileText ?? "") !== input.record.fileFingerprint) {
    return { state: "conflict", reason: "foreign-edit" };
  }
  return input.record.blockFingerprint === fingerprint(canonicalContribution(input.contribution))
    ? { state: "current" }
    : { state: "stale" };
}

export interface IntegrationStateInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The whole integration state store, bound to one root. */
  store?: IntegrationStateStore;
  io?: IntegrationIO;
}

export function exportContextOf(input: {
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
}): { baseUrl: string; models: readonly ExportModel[]; config: OcxConfig } {
  return {
    baseUrl: `http://${input.config.hostname ?? "127.0.0.1"}:${input.port}/v1`,
    models: input.models,
    config: input.config,
  };
}

let retriedThisProcess = false;

/**
 * Retry pending prunes once per process for the default store, and always for
 * an explicitly supplied one so tests stay order-independent. Never throws: a
 * retry failure is a logged no-op, not a failed read.
 */
export function retryPendingPrunesOnce(store: IntegrationStateStore): void {
  if (store.root === createIntegrationStateStore().root) {
    if (retriedThisProcess) return;
    retriedThisProcess = true;
  }
  try {
    store.retryPendingPrunes();
  } catch (error) {
    console.error(`[integrations] prune retry failed: ${String(error)}`);
  }
}

/**
 * Retention is derived from what is ON DISK, not from the maintenance marker.
 * The marker schedules retries and can itself fail to write; a promise about
 * the user's credential-bearing backups must not depend on that.
 */
function retentionOf(
  clientId: IntegrationClientId,
  store: IntegrationStateStore,
): { snapshotCount: number; retentionDegraded: boolean } {
  const counted = store.countSnapshots(clientId);
  if (counted === null) {
    // Cannot inspect: report degraded with -1 rather than a reassuring zero.
    return { snapshotCount: -1, retentionDegraded: true };
  }
  const marked = store.readMaintenance().pruneFailures[clientId] !== undefined;
  return { snapshotCount: counted, retentionDegraded: marked || counted > SNAPSHOT_RETENTION };
}

/** The ONE reader every surface uses. */
export function readIntegrationState(input: IntegrationStateInput): IntegrationStatus {
  const store = input.store ?? createIntegrationStateStore();
  retryPendingPrunesOnce(store);
  const io = input.io ?? store.io();
  const spec = INTEGRATION_CLIENTS[input.clientId];
  const exportSpec = EXPORT_CLIENTS[input.clientId];
  const configPath = spec.configPath(input.env, input.home);
  const installed = io.statKind(spec.detectDir(input.env, input.home)) === "dir";
  const retention = retentionOf(input.clientId, store);

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      clientId: input.clientId,
      state: "unsafe",
      installed,
      configPath,
      reason: target.why === "read-failed" ? "unparseable" : "not-regular-file",
      ...retention,
    };
  }

  const parsed = parseConfig(target.before, exportSpec.format);
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = store.readRecords()[input.clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: target.before,
    fileIsRegular: true,
    parsed,
    record,
    contribution,
    configPath,
    clientId: input.clientId,
  });

  return {
    clientId: input.clientId,
    state,
    installed,
    configPath,
    ...(reason ? { reason } : {}),
    ...(record ? { appliedAt: record.appliedAt, lastOpId: record.opId } : {}),
    ...retention,
  };
}
