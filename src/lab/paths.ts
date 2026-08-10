import { chmodSync, existsSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";

/** Create (or harden) a directory to mode 0o700 without following symlinks. */
export function ensureRestrictedDir(dir: string): void {
  if (process.platform === "win32") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  const abs = resolve(dir);
  const parts = abs.split(sep);
  let current = parts[0] === "" ? sep : parts[0]!;
  for (const part of parts.slice(1)) {
    if (part === "") continue;
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    const componentStats = lstatSync(current);
    if (componentStats.isSymbolicLink()) {
      throw new Error(`restricted directory component is a symbolic link: ${current}`);
    }
    if (!componentStats.isDirectory()) {
      throw new Error(`restricted path component is not a directory: ${current}`);
    }
  }
  if (!existsSync(abs)) return;
  const stats = lstatSync(abs);
  if (stats.isSymbolicLink()) {
    throw new Error(`restricted directory is a symbolic link: ${abs}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`restricted path is not a directory: ${abs}`);
  }
  const mode = stats.mode & 0o777;
  if (mode !== 0o700) chmodSync(abs, 0o700);
}

/** Canonical Compatibility Lab state root under the OpenCodex config dir. */
export function labRoot(configDir = getConfigDir()): string {
  return join(configDir, "lab");
}

export function labLedgerPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "compatibility.jsonl");
}

export function labSqlitePath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "compatibility.sqlite");
}

export function labArtifactsDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "artifacts");
}

export function labScratchDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "scratch");
}

export function labExportDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "export");
}

/** Opaque per-installation salt for local fingerprinting (never exported as evidence). */
export function labInstallationSaltPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "installation-salt.bin");
}

/** Ensure lab directories exist with restrictive permissions where the platform allows. */
export function ensureLabDirs(configDir = getConfigDir()): {
  root: string;
  ledgerPath: string;
  sqlitePath: string;
  artifactsDir: string;
  scratchDir: string;
  exportDir: string;
} {
  const root = labRoot(configDir);
  const artifactsDir = labArtifactsDir(configDir);
  const scratchDir = labScratchDir(configDir);
  const exportDir = labExportDir(configDir);
  ensureRestrictedDir(root);
  ensureRestrictedDir(artifactsDir);
  ensureRestrictedDir(scratchDir);
  ensureRestrictedDir(exportDir);
  return {
    root,
    ledgerPath: labLedgerPath(configDir),
    sqlitePath: labSqlitePath(configDir),
    artifactsDir,
    scratchDir,
    exportDir,
  };
}
