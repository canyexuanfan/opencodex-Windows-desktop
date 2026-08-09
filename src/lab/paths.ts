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

/** Ensure lab directories exist with restrictive permissions where the platform allows. */
export function ensureLabDirs(configDir = getConfigDir()): {
  root: string;
  ledgerPath: string;
  sqlitePath: string;
  artifactsDir: string;
} {
  const root = labRoot(configDir);
  const artifactsDir = labArtifactsDir(configDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ledgerPath: labLedgerPath(configDir),
    sqlitePath: labSqlitePath(configDir),
    artifactsDir,
  };
}
