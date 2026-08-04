import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { getConfigDir } from "../config";
import { catalogHasRoutedEntries, parseCatalogJson } from "./catalog/parsing";
import {
  hasInjectedCodexRouting,
  OCX_SECTION_MARKER,
  providerTableString,
  rootTomlString,
} from "./injected-marker";
import {
  CODEX_CONFIG_PATH,
  CODEX_MODELS_CACHE_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
} from "./paths";

export type NativeResidueSurface =
  | "config"
  | "profile"
  | "catalog"
  | "models-cache"
  | "journal"
  | "partial-write"
  | "history"
  | "history-backup";

export type NativeRoutedResidueResult =
  | { kind: "clean" }
  | { kind: "residue"; surface: NativeResidueSurface; path: string }
  | { kind: "indeterminate"; surface: NativeResidueSurface; path: string; reason: string };

type ReadResult =
  | { kind: "absent" }
  | { kind: "content"; content: string; path: string }
  | { kind: "indeterminate"; reason: string };

type PathResult =
  | { kind: "absent" }
  | { kind: "path"; path: string; stat: Stats }
  | { kind: "indeterminate"; reason: string };

const CONFIG_FILE_NAME = basename(CODEX_CONFIG_PATH);
const PROFILE_FILE_NAME = basename(CODEX_PROFILE_PATH);
const CATALOG_FILE_NAME = basename(DEFAULT_CATALOG_PATH);
const MODELS_CACHE_FILE_NAME = basename(CODEX_MODELS_CACHE_PATH);
const JOURNAL_FILE_NAME = "opencodex-journal.json";
const HISTORY_DATABASE_FILE_NAME = "state_5.sqlite";
const ROUTED_CATALOG_DESCRIPTION_PREFIX = "Routed via opencodex → ";

const ATOMIC_WRITE_TARGETS = new Set([
  CONFIG_FILE_NAME,
  PROFILE_FILE_NAME,
  CATALOG_FILE_NAME,
  MODELS_CACHE_FILE_NAME,
  JOURNAL_FILE_NAME,
]);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function sameStat(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function resolveRegularFile(path: string): PathResult {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "indeterminate", reason: errorReason(error) };
  }

  let target = path;
  if (entry.isSymbolicLink()) {
    try {
      target = realpathSync.native(path);
    } catch (error) {
      return { kind: "indeterminate", reason: `unresolvable symlink: ${errorReason(error)}` };
    }
  }

  try {
    const before = statSync(target);
    if (!before.isFile()) {
      return { kind: "indeterminate", reason: "surface is not a regular file" };
    }
    return { kind: "path", path: target, stat: before };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function readRegularFile(path: string): ReadResult {
  const resolved = resolveRegularFile(path);
  if (resolved.kind !== "path") return resolved;
  try {
    const content = readFileSync(resolved.path, "utf8");
    const after = statSync(resolved.path);
    if (!sameStat(resolved.stat, after)) {
      return { kind: "indeterminate", reason: "surface changed while it was being observed" };
    }
    return { kind: "content", content, path: resolved.path };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function indeterminate(
  surface: NativeResidueSurface,
  path: string,
  reason: string,
): NativeRoutedResidueResult {
  return { kind: "indeterminate", surface, path, reason };
}

function classifyToml(
  surface: "config" | "profile",
  path: string,
  classify: (content: string) => "clean" | "residue" | "indeterminate",
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  try {
    Bun.TOML.parse(read.content);
  } catch (error) {
    return indeterminate(surface, path, `malformed TOML: ${errorReason(error)}`);
  }
  const result = classify(read.content);
  if (result === "residue") return { kind: "residue", surface, path: read.path };
  if (result === "indeterminate") {
    return indeterminate(surface, read.path, "OpenCodex-shaped TOML does not match a complete routed grammar");
  }
  return { kind: "clean" };
}

function classifyConfig(path: string): NativeRoutedResidueResult {
  return classifyToml("config", path, content => {
    if (hasInjectedCodexRouting(content)) return "residue";
    const hasMarker = content.includes(OCX_SECTION_MARKER);
    const provider = rootTomlString(content, "model_provider");
    const providerBaseUrl = providerTableString(content, "opencodex", "base_url");
    return hasMarker || provider === "opencodex" || providerBaseUrl !== null
      ? "indeterminate"
      : "clean";
  });
}

function classifyProfile(path: string): NativeRoutedResidueResult {
  return classifyToml("profile", path, content => {
    const generatedFallback = content.startsWith("# OpenCodex proxy fallback config (Design B)")
      && rootTomlString(content, "openai_base_url") !== null;
    const generatedNamedProfile = content.startsWith("# OpenCodex proxy profile — use with:")
      && hasInjectedCodexRouting(content);
    if (generatedFallback || generatedNamedProfile) return "residue";
    return "indeterminate";
  });
}

function isOcxRoutedCatalogEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.slug === "string"
    && entry.slug.includes("/")
    && typeof entry.description === "string"
    && entry.description.startsWith(ROUTED_CATALOG_DESCRIPTION_PREFIX);
}

function classifyCatalogLike(
  surface: "catalog" | "models-cache",
  path: string,
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  const catalog = parseCatalogJson(read.content);
  if (!catalog) return indeterminate(surface, path, "malformed catalog JSON");
  if ((catalog.models ?? []).some(isOcxRoutedCatalogEntry)) {
    return { kind: "residue", surface, path: read.path };
  }
  if (catalogHasRoutedEntries(catalog)) {
    return indeterminate(surface, read.path, "routed catalog rows lack the OpenCodex authorship signature");
  }
  return { kind: "clean" };
}

function isJournal(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return journal.version === 1
    && typeof journal.originalConfig === "string"
    && (journal.originalProfile === null || typeof journal.originalProfile === "string")
    && typeof journal.pid === "number"
    && Number.isInteger(journal.pid)
    && typeof journal.timestamp === "string";
}

function classifyJournal(path: string): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate("journal", path, read.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return indeterminate("journal", read.path, `malformed journal JSON: ${errorReason(error)}`);
  }
  return isJournal(parsed)
    ? { kind: "residue", surface: "journal", path: read.path }
    : indeterminate("journal", read.path, "journal JSON has an unknown or partial shape");
}

function classifyPartialWrites(codexHome: string): NativeRoutedResidueResult {
  let names: string[];
  try {
    names = readdirSync(codexHome);
  } catch (error) {
    return indeterminate("partial-write", codexHome, errorReason(error));
  }
  for (const name of names) {
    const match = /^(.*)\.ocx\.\d+\.\d+\.tmp$/.exec(name);
    if (match?.[1] && ATOMIC_WRITE_TARGETS.has(match[1])) {
      return indeterminate("partial-write", join(codexHome, name), "OpenCodex atomic-write artifact is still present");
    }
  }
  return { kind: "clean" };
}

function classifyHistoryDatabase(path: string): NativeRoutedResidueResult {
  const resolved = resolveRegularFile(path);
  if (resolved.kind === "absent") {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = resolveRegularFile(`${path}${suffix}`);
      if (sidecar.kind !== "absent") {
        const reason = sidecar.kind === "indeterminate"
          ? sidecar.reason
          : "SQLite sidecar exists without its history database";
        return indeterminate("history", `${path}${suffix}`, reason);
      }
    }
    return { kind: "clean" };
  }
  if (resolved.kind === "indeterminate") return indeterminate("history", path, resolved.reason);
  let database: Database | undefined;
  try {
    database = new Database(resolved.path, { readonly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const row = database.query<{ n: number }, []>(`
      SELECT count(*) AS n
      FROM threads
      WHERE model_provider = 'opencodex'
        AND trim(coalesce(first_user_message, '')) != ''
    `).get();
    const after = statSync(resolved.path);
    if (!sameStat(resolved.stat, after)) {
      return indeterminate("history", resolved.path, "history database changed while it was being observed");
    }
    return (row?.n ?? 0) > 0
      ? { kind: "residue", surface: "history", path: resolved.path }
      : { kind: "clean" };
  } catch (error) {
    return indeterminate("history", resolved.path, `unreadable history database: ${errorReason(error)}`);
  } finally {
    try { database?.close(); } catch { /* the observation already failed closed */ }
  }
}

function historyBackupPath(stateDatabasePath: string): string {
  const normalized = process.platform === "win32"
    ? resolve(stateDatabasePath).toLowerCase()
    : resolve(stateDatabasePath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `codex-history-backup-${id}.json`);
}

function classifyHistoryBackup(path: string, stateDatabasePath: string): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate("history-backup", path, read.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return indeterminate("history-backup", read.path, `malformed history backup JSON: ${errorReason(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return indeterminate("history-backup", read.path, "history backup has an unknown shape");
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.version !== 1 || !manifest.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
    return indeterminate("history-backup", read.path, "history backup has an unknown shape");
  }
  if (typeof manifest.stateDbPath === "string") {
    const expected = process.platform === "win32" ? resolve(stateDatabasePath).toLowerCase() : resolve(stateDatabasePath);
    const actual = process.platform === "win32" ? resolve(manifest.stateDbPath).toLowerCase() : resolve(manifest.stateDbPath);
    if (actual !== expected) {
      return indeterminate("history-backup", read.path, "history backup names a different state database");
    }
  }
  return Object.keys(manifest.entries as Record<string, unknown>).length > 0
    ? { kind: "residue", surface: "history-backup", path: read.path }
    : { kind: "clean" };
}

/** Read-only, fail-closed observation of every OpenCodex-routed Codex surface. */
export function classifyNativeRoutedResidue(): NativeRoutedResidueResult {
  let codexHome: string;
  try {
    codexHome = getCodexHome();
  } catch (error) {
    const unresolved = process.env.CODEX_HOME?.trim() || "CODEX_HOME";
    return indeterminate("partial-write", unresolved, `CODEX_HOME cannot be resolved: ${errorReason(error)}`);
  }

  const stateDatabasePath = join(codexHome, HISTORY_DATABASE_FILE_NAME);
  const classifiers = [
    () => classifyPartialWrites(codexHome),
    () => classifyConfig(join(codexHome, CONFIG_FILE_NAME)),
    () => classifyProfile(join(codexHome, PROFILE_FILE_NAME)),
    () => classifyCatalogLike("catalog", join(codexHome, CATALOG_FILE_NAME)),
    () => classifyCatalogLike("models-cache", join(codexHome, MODELS_CACHE_FILE_NAME)),
    () => classifyJournal(join(codexHome, JOURNAL_FILE_NAME)),
    () => classifyHistoryDatabase(stateDatabasePath),
    () => classifyHistoryBackup(historyBackupPath(stateDatabasePath), stateDatabasePath),
  ];
  const results = classifiers.map(classify => classify());
  return results.find(result => result.kind === "indeterminate")
    ?? results.find(result => result.kind === "residue")
    ?? { kind: "clean" };
}
