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

export const PARSE_FAILED = Symbol("parse-failed");

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
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  io?: IntegrationIO;
}

export function readIntegrationState(input: IntegrationStateInput): IntegrationStatus {
  const io = input.io ?? defaultIntegrationIO();
  const spec = INTEGRATION_CLIENTS[input.clientId];
  const exportSpec = EXPORT_CLIENTS[input.clientId];
  const configPath = spec.configPath(input.env);
  const installed = io.statKind(spec.detectDir(input.env, input.home)) === "dir";

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      clientId: input.clientId, state: "unsafe", installed, configPath,
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
    ...(reason ? { reason } : {}),
    ...(record ? { appliedAt: record.appliedAt, lastOpId: record.opId } : {}),
  };
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
function snapshotDir(clientId: IntegrationClientId): string {
  return join(integrationsDir(), "snapshots", clientId);
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
  // Post-commit, best-effort. Old snapshot bytes lingering one extra cycle is
  // harmless; a false append failure is not.
  try { pruneSnapshots(entry.clientId); } catch { /* best effort by contract */ }
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
function pruneSnapshots(clientId: IntegrationClientId): void {
  const keep = new Set(
    listOperations(clientId, SNAPSHOT_RETENTION)
      .map(r => (r.snapshot.kind === "stored" ? r.opId : null))
      .filter((v): v is string => v !== null),
  );
  let names: string[];
  try { names = readdirSync(snapshotDir(clientId)); } catch { return; }
  for (const name of names) {
    if (!keep.has(name)) rmSync(join(snapshotDir(clientId), name), { force: true });
  }
}
```

## 5. Activation table

| Branch | Trigger | Observable proof |
|---|---|---|
| corrupt records file | write `{{{` to `records.json`, then classify a config carrying our fragments | `state === "conflict"`, `reason === "unowned-key"` (fail closed, never delete) |
| torn journal line | append a truncated line, then `listOperations` | valid rows returned, no throw |
| retention prune | append 11 stored-snapshot ops for one client | 11 rows listed; `readSnapshot(oldest).kind === "expired"` |
| snapshot `none` | capture with `text === null` | entry's `snapshot.kind === "none"`; `readSnapshot` returns `none`, not `expired` |
| fragment sort stability | build the same contribution with fragments emitted in reverse order | identical `blockFingerprint` |
| path read miss | classify a doc whose `providers` is an array | `hasOurFragments` false → `absent`, no throw |

## 6. Tests

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
