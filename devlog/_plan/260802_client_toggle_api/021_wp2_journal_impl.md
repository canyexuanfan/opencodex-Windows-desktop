# 021 — WP2 bodies: ownership record, classifier, journal

> **Status: verified by `tools/check-blocks.ts` (see `007_execution_method.md`).**
> The bodies below are compiled as self-contained units by the block checker.
> They remain the paste source; the checker guarantees they parse and are
> internally consistent, while cross-module resolution is settled by the
> repository's own `bun run typecheck` during the implementing phase.



Paste-ready implementation for `020`. Types come from `006_module_contracts.md`
(authoritative). Sub-decade doc per LEXICO-SPLIT-01 overflow; same phase as 020.

## 1. `src/integrations/registry.ts` (NEW)

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { EXPORT_CLIENTS, type ExportClientId } from "../clients/config-export";

/** Readability alias. WP1 owns the type; this never introduces a new one. */
export type IntegrationClientId = ExportClientId;

export interface IntegrationClientSpec {
  id: IntegrationClientId;
  /** The client's config file. Delegates to WP1, which already resolves env overrides. */
  configPath: (env?: NodeJS.ProcessEnv) => string;
  /** Directory whose existence is the "is it installed?" signal. */
  detectDir: (env?: NodeJS.ProcessEnv, home?: string) => string;
  /** Kimi cannot carry an env reference, so a remote bind would force a real secret. */
  loopbackOnly: boolean;
}

function xdgConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : join(home, ".config");
}

export const INTEGRATION_CLIENTS: Record<IntegrationClientId, IntegrationClientSpec> = {
  opencode: {
    id: "opencode",
    configPath: (env = process.env) => EXPORT_CLIENTS.opencode.destination(env),
    detectDir: (env = process.env, home = homedir()) => join(xdgConfigHome(env, home), "opencode"),
    loopbackOnly: false,
  },
  pi: {
    id: "pi",
    configPath: (env = process.env) => EXPORT_CLIENTS.pi.destination(env),
    detectDir: (_env = process.env, home = homedir()) => join(home, ".pi"),
    loopbackOnly: false,
  },
  hermes: {
    id: "hermes",
    configPath: (env = process.env) => EXPORT_CLIENTS.hermes.destination(env),
    detectDir: (env = process.env, home = homedir()) => hermesHome(env, home),
    loopbackOnly: false,
  },
  openclaw: {
    id: "openclaw",
    configPath: (env = process.env) => EXPORT_CLIENTS.openclaw.destination(env),
    detectDir: (_env = process.env, home = homedir()) => join(home, ".openclaw"),
    loopbackOnly: false,
  },
  kimi: {
    id: "kimi",
    configPath: (env = process.env) => EXPORT_CLIENTS.kimi.destination(env),
    detectDir: (env = process.env, home = homedir()) =>
      env.KIMI_CODE_HOME && env.KIMI_CODE_HOME.trim().length > 0
        ? env.KIMI_CODE_HOME.trim()
        : join(home, ".kimi-code"),
    loopbackOnly: true,
  },
  gajae: {
    id: "gajae",
    configPath: (env = process.env) => EXPORT_CLIENTS.gajae.destination(env),
    detectDir: (_env = process.env, home = homedir()) => join(home, ".gjc"),
    loopbackOnly: false,
  },
};

export const INTEGRATION_CLIENT_IDS: readonly IntegrationClientId[] =
  Object.keys(INTEGRATION_CLIENTS) as IntegrationClientId[];

export function isIntegrationClientId(value: string): value is IntegrationClientId {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_CLIENTS, value);
}

/** Mirrors WP1's hermesConfigPath resolution so detection and write agree. */
function hermesHome(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.HERMES_HOME?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return join(local && local.length > 0 ? local : join(home, "AppData", "Local"), "hermes");
  }
  return join(home, ".hermes");
}
```

## 2. `src/integrations/ownership.ts` (NEW)

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// `resolveConfigDir` is PRIVATE in src/config.ts; `getConfigDir` is the public
// accessor (A-gate round 3, blocker 2).
import { atomicWriteFile, getConfigDir } from "../config";
import type { ManagedContribution, ManagedFragment } from "../clients/config-export";
import type { IntegrationClientId } from "./registry";

/** 16 hex chars — same shape as the Claude Desktop applied fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Canonical bytes of a contribution, for the block fingerprint. Fragments are
 * sorted by path so two builds of the same contribution hash identically
 * regardless of emission order.
 */
export function canonicalContribution(contribution: ManagedContribution): string {
  const sorted = [...contribution.fragments].sort((a, b) =>
    a.path.join("\u0000") < b.path.join("\u0000") ? -1 : 1,
  );
  return JSON.stringify(sorted.map(f => [f.path, f.value]));
}

export interface OwnershipRecord {
  clientId: IntegrationClientId;
  configPath: string;
  /** Hash of the WHOLE file as we left it — detects foreign edits after us. */
  fileFingerprint: string;
  /** Hash of our contribution — detects catalog/port drift. */
  blockFingerprint: string;
  /** The exact paths we own. Removal touches these and nothing else. */
  fragmentPaths: readonly (readonly string[])[];
  appliedAt: string;
  opId: string;
}

/** `dir` is the test seam — no env mutation required. */
export function integrationsDir(dir: string = getConfigDir()): string {
  return join(dir, "integrations");
}

function recordsPath(): string {
  return join(integrationsDir(), "records.json");
}

export function readRecords(): Partial<Record<IntegrationClientId, OwnershipRecord>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<Record<IntegrationClientId, OwnershipRecord>>)
      : {};
  } catch {
    // A missing or corrupt record file means "we remember nothing", which the
    // classifier reads as conflict for an existing block — fail closed, never
    // as permission to delete.
    return {};
  }
}

export function writeRecord(record: OwnershipRecord): void {
  const all = readRecords();
  all[record.clientId] = record;
  ensureDir(recordsPath());
  atomicWriteFile(recordsPath(), JSON.stringify(all, null, 2) + "\n");
}

export function deleteRecord(clientId: IntegrationClientId): void {
  const all = readRecords();
  if (!(clientId in all)) return;
  delete all[clientId];
  ensureDir(recordsPath());
  atomicWriteFile(recordsPath(), JSON.stringify(all, null, 2) + "\n");
}

/** atomicWriteFile does not create parents (005 §3). */
export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

export function fragmentPathsOf(contribution: ManagedContribution): readonly (readonly string[])[] {
  return contribution.fragments.map((f: ManagedFragment) => f.path);
}
```

## 3. `src/integrations/state.ts` (NEW)

```ts
import type { ManagedContribution } from "../clients/config-export";
import { canonicalContribution, fingerprint, readRecords, type OwnershipRecord } from "./ownership";
// The sentinel is a SYMBOL: two `Symbol("parse-failed")` calls are different
// values, so a second declaration here would make every parse failure compare
// unequal and fall through to `absent` — an unparseable file would then be
// treated as empty and overwritten (A-gate round 10, blocker 1).
import { PARSE_FAILED } from "./config-io";
import { INTEGRATION_CLIENTS, type IntegrationClientId } from "./registry";

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
  /** Snapshot files currently retained for this client. */
  snapshotCount: number;
  /** True when pruning is behind, so old (possibly credential-bearing)
   *  snapshots may still exist. Derived from the count, with the maintenance
   *  marker as a retry hint only (006 §5). */
  retentionDegraded: boolean;
}


/** Does the document carry every fragment path we would write? */
export function hasOurFragments(doc: unknown, contribution: ManagedContribution): boolean {
  return contribution.fragments.some(f => readPath(doc, f.path) !== undefined);
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

/**
 * The two-axis rule (003 §3): the file hash proves nobody touched the file
 * after us; the block hash proves our content is still what we would write.
 * Order is load-bearing and pinned by tests: an unreadable file can never be
 * reported absent, and a foreign edit can never be reported stale.
 */
export function classifyIntegration(input: {
  fileText: string | null;
  fileIsRegular: boolean;
  parsed: unknown | typeof PARSE_FAILED;
  record: OwnershipRecord | null;
  contribution: ManagedContribution;
}): { state: IntegrationState; reason?: StateReason } {
  if (input.fileText !== null && !input.fileIsRegular) {
    return { state: "unsafe", reason: "not-regular-file" };
  }
  if (input.parsed === PARSE_FAILED) return { state: "unsafe", reason: "unparseable" };
  if (!hasOurFragments(input.parsed, input.contribution)) return { state: "absent" };
  if (!input.record) return { state: "conflict", reason: "unowned-key" };
  if (fingerprint(input.fileText ?? "") !== input.record.fileFingerprint) {
    return { state: "conflict", reason: "foreign-edit" };
  }
  return input.record.blockFingerprint === fingerprint(canonicalContribution(input.contribution))
    ? { state: "current" }
    : { state: "stale" };
}
```

`readIntegrationState` (the exported entry point named in 006 §5) composes
this with the IO seam. It lives in `state.ts` and is the ONE reader every
surface uses:

```ts
import { EXPORT_CLIENTS, type ExportModel } from "../clients/config-export";
import type { OcxConfig } from "../types";
import { parseConfig } from "./config-io";
import { defaultIntegrationIO, loadTarget, type IntegrationIO } from "./config-io";

export interface IntegrationStateInput {
  clientId: IntegrationClientId;
  /**
   * Opencodex config root for integration state. Threaded so a test redirects
   * maintenance reads, snapshot counting and pruning to a temp dir instead of
   * touching the developer's real store (A-gate round 10, blocker 3).
   */
  stateDir?: string;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  io?: IntegrationIO;
}

export function readIntegrationState(input: IntegrationStateInput): IntegrationStatus {
  retryPendingPrunesOnce(input.stateDir);   // scoped to the caller's store; never throws
  const io = input.io ?? defaultIntegrationIO();
  const spec = INTEGRATION_CLIENTS[input.clientId];
  const exportSpec = EXPORT_CLIENTS[input.clientId];
  const configPath = spec.configPath(input.env);
  const installed = io.statKind(spec.detectDir(input.env, input.home)) === "dir";

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      clientId: input.clientId, state: "unsafe", installed, configPath,
      ...retentionOf(input.clientId, input.stateDir),
      reason: target.why === "read-failed" ? "unparseable" : "not-regular-file",
    };
  }

  const parsed = parseConfig(target.before, exportSpec.format);
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = readRecords()[input.clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: target.before, fileIsRegular: true, parsed, record, contribution,
  });

  return {
    clientId: input.clientId, state, installed, configPath,
    ...retentionOf(input.clientId, input.stateDir),
    ...(reason ? { reason } : {}),
    ...(record ? { appliedAt: record.appliedAt, lastOpId: record.opId } : {}),
  };
}

/**
 * Retention is derived from what is ON DISK, not from the maintenance marker.
 * The marker schedules retries; it can itself fail to write, and a promise
 * about the user's credential-bearing backups must not depend on a write that
 * can fail (006 §5).
 */
function retentionOf(clientId: IntegrationClientId, dir?: string): { snapshotCount: number; retentionDegraded: boolean } {
  const counted = countSnapshots(clientId, dir);
  if (counted === null) {
    // Cannot inspect: report degraded with a count of -1 rather than a
    // reassuring zero. "Unknown" and "healthy" must never look alike here.
    return { snapshotCount: -1, retentionDegraded: true };
  }
  // A marked failure keeps the flag set even when the count is momentarily
  // within bound, so a retry that has not run yet is still visible.
  const marked = readMaintenance(dir).pruneFailures[clientId] !== undefined;
  return { snapshotCount: counted, retentionDegraded: marked || counted > SNAPSHOT_RETENTION };
}
```

`loadTarget` and `defaultIntegrationIO` live in `src/integrations/config-io.ts`
(shared by the reader and the writer so they can never disagree about what
counts as absence); their bodies are in `021` §5 (WP2 owns it).

## 4. `src/integrations/journal.ts` (NEW)

```ts
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { ensureDir, integrationsDir } from "./ownership";
import type { IntegrationClientId } from "./registry";

export type OperationKind = "apply" | "disable" | "refresh" | "restore";

export type SnapshotRef =
  | { kind: "none" }
  | { kind: "stored"; relPath: string }
  | { kind: "expired" };

export interface JournalEntry {
  opId: string;
  clientId: IntegrationClientId;
  kind: OperationKind;
  at: string;
  configPath: string;
  snapshot: SnapshotRef;
  /** Fingerprint of the file AFTER this op; "" when the op left no file. */
  resultFingerprint: string;
  /** True when the op's result was file absence — restore means "delete". */
  resultAbsent: boolean;
  /**
   * Ownership as it stood BEFORE this operation. Restore puts this back
   * alongside the bytes, so provenance always describes the file it came with
   * and is never re-derived from a provider-id prefix (006 §3).
   */
  priorRecord: OwnershipRecord | null;
}

const SNAPSHOT_RETENTION = 10;

export function newOpId(): string { return randomUUID(); }

function journalPath(): string { return join(integrationsDir(), "journal.jsonl"); }
function snapshotDir(clientId: IntegrationClientId, dir?: string): string {
  return join(integrationsDir(dir), "snapshots", clientId);
}

/**
 * Copy the file as it is right now. Snapshot bytes can contain the user's own
 * credentials (we copy their file verbatim), so they go through
 * atomicWriteFile, which applies 0600 plus Windows ACL hardening.
 */
export function captureSnapshot(
  clientId: IntegrationClientId, opId: string, text: string | null,
): SnapshotRef {
  if (text === null) return { kind: "none" };
  const target = join(snapshotDir(clientId), opId);
  ensureDir(target);
  atomicWriteFile(target, text);
  return { kind: "stored", relPath: join("snapshots", clientId, opId) };
}

/**
 * Commit the row. Nothing else: a pruning failure must never look like an
 * append failure, or the writer would compensate for an operation that
 * already succeeded — the phantom row the ordering exists to prevent
 * (A-gate round 4, blocker 5).
 */
export function appendOperation(entry: JournalEntry): void {
  ensureDir(journalPath());
  appendFileSync(journalPath(), JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
  // Post-commit. A prune failure never fails the append — but it is marked so
  // a later operation retries it, and `retentionDegraded` reports it meanwhile.
  // Everything after the append is best-effort AND non-throwing: the row is
  // already committed, so an exception here would be read by the writer as an
  // append failure and trigger compensation for work that succeeded.
  try {
    const pruned = pruneSnapshots(entry.clientId);
    if (pruned.ok) clearPruneFailure(entry.clientId);
    else markPruneFailure(entry.clientId, pruned.error);
  } catch (error) {
    console.error(`[integrations] post-commit maintenance failed: ${String(error)}`);
  }
}

/** Newest first. A torn final line (crash mid-append) is skipped, not thrown. */
export function listOperations(clientId?: IntegrationClientId, limit = 50): JournalEntry[] {
  let raw: string;
  try { raw = readFileSync(journalPath(), "utf8"); } catch { return []; }
  const rows: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (!clientId || parsed.clientId === clientId) rows.push(parsed);
    } catch { /* torn line */ }
  }
  return rows.reverse().slice(0, limit);
}

export function findOperation(opId: string): JournalEntry | null {
  return listOperations(undefined, Number.MAX_SAFE_INTEGER).find(r => r.opId === opId) ?? null;
}

/** Resolves the tag against what is actually on disk now. */
export function readSnapshot(entry: JournalEntry):
  | { kind: "none" } | { kind: "stored"; text: string; path: string } | { kind: "expired" } {
  if (entry.snapshot.kind === "none") return { kind: "none" };
  if (entry.snapshot.kind === "expired") return { kind: "expired" };
  const abs = join(integrationsDir(), entry.snapshot.relPath);
  if (!existsSync(abs)) return { kind: "expired" };
  return { kind: "stored", text: readFileSync(abs, "utf8"), path: abs };
}

/** Keep the newest N snapshot files per client; rows always survive. */
/**
 * Snapshot files retained right now — the witness for `retentionDegraded`.
 *
 * `null` means "cannot inspect", which is NOT the same as zero. Reporting an
 * unreadable snapshot directory as a healthy empty one would hide exactly the
 * unbounded, credential-bearing pile this field exists to disclose
 * (A-gate round 9, blocker 3).
 */
export function countSnapshots(clientId: IntegrationClientId, dir?: string): number | null {
  try { return readdirSync(snapshotDir(clientId, dir)).length; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  }
}

/**
 * Keep the newest N snapshot files per client; journal rows always survive.
 *
 * Structured rather than throwing or swallowing: a swallowed failure would let
 * credential-bearing snapshots pile up while every operation reported success
 * (006 §5). The caller marks the failure and a later operation retries.
 */
export function pruneSnapshots(clientId: IntegrationClientId, dir?: string): { ok: true } | { ok: false; error: string } {
  const keep = new Set(
    listOperations(clientId, SNAPSHOT_RETENTION)
      .map(r => (r.snapshot.kind === "stored" ? r.opId : null))
      .filter((v): v is string => v !== null),
  );
  let names: string[];
  try { names = readdirSync(snapshotDir(clientId, dir)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true };   // nothing written yet
    return { ok: false, error: String(error) };
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try { rmSync(join(snapshotDir(clientId, dir), name), { force: true }); }
    catch (error) { return { ok: false, error: String(error) }; }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Maintenance marker: a retry hint, never the witness.
// ---------------------------------------------------------------------------

export interface MaintenanceState {
  pruneFailures: Partial<Record<IntegrationClientId, { at: string; error: string }>>;
}

function maintenancePath(dir?: string): string { return join(integrationsDir(dir), "maintenance.json"); }

export function readMaintenance(dir?: string): MaintenanceState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(maintenancePath(dir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Validate rather than cast: `{}` parses fine and would leave
      // `pruneFailures` undefined, so the next mark/clear would throw AFTER
      // the journal row was committed — producing the phantom row the write
      // ordering exists to prevent (A-gate round 9, blocker 2).
      const raw = (parsed as { pruneFailures?: unknown }).pruneFailures;
      const failures: MaintenanceState["pruneFailures"] = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!isIntegrationClientId(key)) continue;
          if (!value || typeof value !== "object") continue;
          const { at, error } = value as { at?: unknown; error?: unknown };
          if (typeof at !== "string" || typeof error !== "string") continue;
          failures[key] = { at, error };
        }
      }
      return { pruneFailures: failures };
    }
  } catch { /* absent or corrupt: no pending retries known */ }
  return { pruneFailures: {} };
}

function writeMaintenance(state: MaintenanceState, dir?: string): void {
  try {
    ensureDir(maintenancePath(dir));
    atomicWriteFile(maintenancePath(dir), JSON.stringify(state, null, 2) + "\n");
  } catch (error) {
    // The marker is an optimization. `retentionDegraded` is derived from the
    // snapshot count, so losing it costs a scheduled retry, not the claim.
    console.error(`[integrations] could not record maintenance state: ${String(error)}`);
  }
}

export function markPruneFailure(clientId: IntegrationClientId, error: string, dir?: string): void {
  const state = readMaintenance();
  state.pruneFailures[clientId] = { at: new Date().toISOString(), error };
  writeMaintenance(state, dir);
}

export function clearPruneFailure(clientId: IntegrationClientId, dir?: string): void {
  const state = readMaintenance();
  if (!(clientId in state.pruneFailures)) return;
  delete state.pruneFailures[clientId];
  writeMaintenance(state, dir);
}

/** Re-attempt every marked client. Called at the start of each operation. */
export function retryPendingPrunes(dir?: string): void {
  for (const clientId of Object.keys(readMaintenance(dir).pruneFailures) as IntegrationClientId[]) {
    if (pruneSnapshots(clientId, dir).ok) clearPruneFailure(clientId, dir);
  }
}

/**
 * Call sites, so the retry is reachable rather than merely defined
 * (A-gate round 9, blocker 3):
 *
 * 1. `readIntegrationState` — once per process, guarded by the flag below, so
 *    simply opening the Integrations tab schedules a retry without making
 *    every status read do filesystem cleanup.
 * 2. `applyIntegration` / `disableIntegration` / `restoreIntegration` — at the
 *    top of each, BEFORE any write, so an operation never begins on top of a
 *    known-degraded snapshot directory.
 *
 * Both call it through `retryPendingPrunesOnce`/`retryPendingPrunes` inside a
 * try/catch; a retry failure is a logged no-op, never an operation failure.
 */
let retriedThisProcess = false;

/**
 * `dir` is threaded from the caller's input, not read from a global. Without
 * it a focused test could prune the DEVELOPER'S real snapshot directory while
 * believing it had substituted the seam wholesale (A-gate round 10, blocker 3).
 * The once-guard is skipped whenever an explicit dir is supplied, so tests are
 * order-independent.
 */
export function retryPendingPrunesOnce(dir?: string): void {
  if (dir === undefined) {
    if (retriedThisProcess) return;
    retriedThisProcess = true;
  }
  try { retryPendingPrunes(dir); }
  catch (error) { console.error(`[integrations] prune retry failed: ${String(error)}`); }
}
```

## 5. `src/integrations/config-io.ts` (NEW)

The seam both the reader and the writer use. It lives in WP2 because
`readIntegrationState` needs it, and WP2 must typecheck with no WP3 file
present (006 §8). WP3 imports these three symbols and declares none of them.

```ts
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { atomicWriteFile } from "../config";
import type { ConfigFormat } from "../clients/config-export";

export const PARSE_FAILED = Symbol("parse-failed");

/** Parse a client config, tolerating absence. PARSE_FAILED on garbage. */
export function parseConfig(text: string | null, format: ConfigFormat): unknown | typeof PARSE_FAILED {
  if (text === null || text.trim().length === 0) return {};
  try {
    switch (format) {
      case "json": return JSON.parse(text);
      case "json5": return Bun.JSON5.parse(text);
      case "yaml": return Bun.YAML.parse(text);
      case "toml": return Bun.TOML.parse(text);
    }
  } catch {
    return PARSE_FAILED;
  }
}

export interface IntegrationIO {
  readText: (path: string) =>
    | { kind: "text"; text: string }
    | { kind: "missing" }
    | { kind: "failed"; code?: string };
  /** `failed` is distinct from `missing`: a path we cannot stat is not absent. */
  statKind: (path: string) => "file" | "dir" | "other" | "missing" | "failed";
  writeText: (path: string, text: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (path: string) => void;
  now: () => number;
  appendJournal: (entry: JournalEntry) => void;
  putRecord: (record: OwnershipRecord) => void;
  dropRecord: (clientId: IntegrationClientId) => void;
}

/** Read + classify the target, collapsing the three failure shapes correctly. */
export function loadTarget(io: IntegrationIO, configPath: string):
  | { ok: true; before: string | null }
  | { ok: false; why: "not-regular-file" | "read-failed" } {
  const kind = io.statKind(configPath);
  if (kind === "missing") return { ok: true, before: null };
  if (kind === "failed") return { ok: false, why: "read-failed" };
  if (kind !== "file") return { ok: false, why: "not-regular-file" };
  const read = io.readText(configPath);
  if (read.kind === "text") return { ok: true, before: read.text };
  // stat said "file" but the read failed: a real file we cannot see. Never
  // treat this as absence — that is how an unreadable config gets clobbered.
  if (read.kind === "failed") return { ok: false, why: "read-failed" };
  return { ok: true, before: null };   // raced deletion between stat and read
}

export function defaultIntegrationIO(): IntegrationIO {
  return {
    readText: p => {
      try { return { kind: "text", text: readFileSync(p, "utf8") }; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ONLY ENOENT is absence. EACCES/EPERM/EISDIR mean a file we cannot
        // see, which must never be overwritten as if it were missing.
        return code === "ENOENT" ? { kind: "missing" } : { kind: "failed", ...(code ? { code } : {}) };
      }
    },
    statKind: p => {
      try { const s = statSync(p); return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other"; }
      catch (error) {
        // Only ENOENT is absence. An EACCES/EPERM stat failure previously
        // returned "missing", which sent loadTarget down the absent path and
        // skipped the tagged read entirely — the unreadable-file protection
        // was bypassed before it ran (A-gate round 10, blocker 2).
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed";
      }
    },
    writeText: (p, t) => atomicWriteFile(p, t),
    removeFile: p => rmSync(p, { force: true }),
    mkdirp: p => mkdirSync(p, { recursive: true, mode: 0o700 }),
    now: () => Date.now(),
    appendJournal: entry => appendOperation(entry),
    putRecord: record => writeRecord(record),
    dropRecord: clientId => deleteRecord(clientId),
  };
}
```

Every test substitutes the seam wholesale — no `node:fs` monkey-patching — and
the `now` member is what makes WP4's stale-flight branch reachable.

## 6. Activation table

| Branch | Trigger | Observable proof |
|---|---|---|
| corrupt records file | write `{{{` to `records.json`, then classify a config carrying our fragments | `state === "conflict"`, `reason === "unowned-key"` (fail closed, never delete) |
| torn journal line | append a truncated line, then `listOperations` | valid rows returned, no throw |
| retention prune | append 11 stored-snapshot ops for one client | 11 rows listed; `readSnapshot(oldest).kind === "expired"` |
| snapshot `none` | capture with `text === null` | entry's `snapshot.kind === "none"`; `readSnapshot` returns `none`, not `expired` |
| fragment sort stability | build the same contribution with fragments emitted in reverse order | identical `blockFingerprint` |
| path read miss | classify a doc whose `providers` is an array | `hasOurFragments` false → `absent`, no throw |
| prune failure marks and retries | make `rmSync` throw for one client, append an op, then let a later op succeed | first: row committed, operation `ok`, marker present, `retentionDegraded` true; second: marker cleared, `retentionDegraded` false, count back within bound |
| malformed marker cannot fake an append failure | write `{}` to `maintenance.json`, then append an op | the row is committed and `appendOperation` returns normally — no throw, so the writer performs no compensation and no phantom row exists |
| unparseable file end to end | call `readIntegrationState` (not the classifier directly) on a config containing `{{{` | `state === "unsafe"` — proves both modules share ONE `PARSE_FAILED` symbol; a split sentinel would report `absent` |
| stat failure is not absence | default IO, `statSync` throws `EACCES` | `loadTarget` returns `read-failed` → `unsafe`; the file is never written |
| genuine ENOENT still reads as absence | default IO, no file present | `loadTarget` returns `{ before: null }`, apply proceeds and creates the file |
| state is scoped to the caller's store | run an operation with `stateDir` pointed at a temp dir while a real marker exists | only the temp dir changes; the real snapshots/marker are byte-identical afterwards |
| unreadable snapshot dir is not healthy | make `readdirSync` throw `EACCES` | `snapshotCount === -1` and `retentionDegraded === true` — never a reassuring `0` |

## 7. Tests

`tests/integrations-journal.test.ts` covers §5 rows 2-4 plus append/list
ordering. `tests/integrations-state.test.ts` covers the 020 §3 table (fixtures
built directly on disk: write config bytes, write a record, classify) plus
§5 rows 1, 5, 6. Each uses `mkdtempSync` with `rmSync` teardown and overrides
the opencodex config dir so nothing touches the developer's real state.

## OPEN QUESTIONS

None. The config-dir seam question is resolved above: `integrationsDir(dir =
getConfigDir())` takes an explicit override, so tests redirect integration
state without mutating the environment, and the module never reaches for the
private `resolveConfigDir`.
