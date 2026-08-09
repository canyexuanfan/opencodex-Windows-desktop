import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

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
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ledgerPath: labLedgerPath(configDir),
    sqlitePath: labSqlitePath(configDir),
    artifactsDir,
    scratchDir,
    exportDir,
  };
}
