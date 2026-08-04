/**
 * Minimal catalog admission for the management refresh path.
 *
 * The r2 #1 catalog incident left gather and native writes in one awaited
 * callback. WP9 needs generation and filesystem-target evidence before it can
 * split those phases, but importing WP12 authority would make WP9 depend on a
 * later phase. This reader therefore captures only the exact resident config,
 * its cooperating generation, and identities for catalog-owned targets.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readConfigGeneration } from "../config";
import type { OcxConfig } from "../types";
import type {
  CatalogAdmissionSnapshot,
  CatalogConvergeRequestInput,
  ConvergeRequest,
} from "./convergence-types";
import {
  activeCodexModelsCachePath,
  catalogBackupPathFor,
  isDefaultCatalogPath,
  legacyCatalogBackupPath,
  readCodexCatalogPath,
} from "./catalog/parsing";

/**
 * Construct the one request shape permitted for management catalog refreshes.
 * Callers choose the deadline only; they cannot widen scope or choose direction.
 */
export function createCatalogConvergeRequest({
  deadlineMs,
}: CatalogConvergeRequestInput): ConvergeRequest {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError("Catalog convergence deadlineMs must be a positive safe integer.");
  }

  return {
    action: "converge",
    scope: "catalog",
    reason: "management-mutation",
    mode: "automatic",
    deadlineMs,
  };
}

function optionalFileIdentity(path: string): Readonly<{ device: string; inode: string }> | null {
  try {
    const entry = statSync(path, { bigint: true });
    return { device: String(entry.dev), inode: String(entry.ino) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Encode identity evidence in the contract-owned string slot.
 *
 * `CatalogAdmissionSnapshot` deliberately owns the target shape. Encoding the
 * evidence here avoids a second shared target type while still detecting the
 * parent-symlink retarget that a textual path alone missed during C2 review.
 */
function captureTargetIdentity(path: string): string {
  const textualPath = resolve(path);
  const canonicalParent = realpathSync.native(dirname(textualPath));
  const parent = statSync(canonicalParent, { bigint: true });
  return JSON.stringify({
    path: textualPath,
    canonicalParent,
    parentIdentity: { device: String(parent.dev), inode: String(parent.ino) },
    fileIdentity: optionalFileIdentity(textualPath),
  });
}

/**
 * Capture the catalog-only evidence WP9 can validate without consulting WP12.
 * The config reference is retained verbatim; no persisted config re-read may
 * replace the object already held by the management callback.
 */
export function captureCatalogAdmissionSnapshot(
  config: Readonly<OcxConfig>,
): CatalogAdmissionSnapshot {
  const generation = readConfigGeneration();
  if (generation.kind !== "ready") {
    throw new Error(`Cannot capture Codex catalog admission: config generation is ${generation.reason}.`);
  }

  const catalogPath = readCodexCatalogPath();
  const backupPaths = [
    catalogBackupPathFor(catalogPath),
    ...(isDefaultCatalogPath(catalogPath) ? [legacyCatalogBackupPath()] : []),
  ];

  return {
    config,
    generation: generation.generation.value,
    targets: {
      catalog: captureTargetIdentity(catalogPath),
      cache: captureTargetIdentity(activeCodexModelsCachePath()),
      catalogBackups: backupPaths.map(captureTargetIdentity),
    },
  };
}
