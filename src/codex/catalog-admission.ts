/**
 * Minimal catalog admission for the management refresh path.
 *
 * The r2 #1 catalog incident left gather and native writes in one awaited
 * callback. WP9 needs generation and filesystem-target evidence before it can
 * split those phases, but importing WP12 authority would make WP9 depend on a
 * later phase. This reader therefore captures only the exact resident config,
 * its cooperating generation, and identities for catalog-owned targets.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { readConfigGeneration } from "../config";
import type { OcxConfig } from "../types";
import type {
  CatalogAdmissionSnapshot,
  CatalogConvergeRequestInput,
  CatalogFilesystemIdentity,
  CatalogSourceObservation,
  ConvergeRequest,
} from "./convergence-types";
import {
  activeCodexConfigPath,
  activeDefaultCatalogPath,
  activeCodexModelsCachePath,
  catalogBackupPathFor,
  isDefaultCatalogPath,
  legacyCatalogBackupPath,
  resolveActiveCodexConfigPath,
} from "./catalog/parsing";
import { readRootTomlString } from "./paths";

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

function catalogFilesystemIdentity(
  entry: Readonly<{ dev: bigint; ino: bigint }>,
): CatalogFilesystemIdentity {
  return { volume: String(entry.dev), fileId: String(entry.ino) };
}

function captureCatalogTargetSelection(): Readonly<{
  catalogPath: string;
  observation: CatalogSourceObservation<"catalog-target-selection">;
}> {
  const logicalPath = resolve(activeCodexConfigPath());
  const canonicalParent = realpathSync.native(dirname(logicalPath));
  const parent = statSync(canonicalParent, { bigint: true });
  const parentIdentity = {
    canonicalPath: canonicalParent,
    ...catalogFilesystemIdentity(parent),
  };

  let bytes: Buffer;
  try {
    bytes = readFileSync(logicalPath);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return {
      catalogPath: activeDefaultCatalogPath(),
      observation: {
        state: "absent",
        role: "catalog-target-selection",
        logicalPath,
        canonicalPath: resolve(canonicalParent, basename(logicalPath)),
        parentIdentity,
        fileIdentity: null,
      },
    };
  }

  const canonicalPath = realpathSync.native(logicalPath);
  const file = statSync(canonicalPath, { bigint: true });
  const configuredCatalogPath = readRootTomlString(bytes.toString("utf8"), "model_catalog_json");

  return {
    catalogPath: configuredCatalogPath
      ? resolveActiveCodexConfigPath(configuredCatalogPath)
      : activeDefaultCatalogPath(),
    observation: {
      state: "present",
      role: "catalog-target-selection",
      logicalPath,
      canonicalPath,
      parentIdentity,
      fileIdentity: catalogFilesystemIdentity(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
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

  const targetSelection = captureCatalogTargetSelection();
  const catalogPath = targetSelection.catalogPath;
  const backupPaths = [
    catalogBackupPathFor(catalogPath),
    ...(isDefaultCatalogPath(catalogPath) ? [legacyCatalogBackupPath()] : []),
  ];

  return {
    config,
    generation: generation.generation,
    targets: {
      catalog: captureTargetIdentity(catalogPath),
      cache: captureTargetIdentity(activeCodexModelsCachePath()),
      catalogBackups: backupPaths.map(captureTargetIdentity),
    },
    sourceEvidence: {
      required: {
        "catalog-target-selection": targetSelection.observation,
      },
      conditional: {
        "bundled-catalog-template": [],
        "active-catalog-merge": [],
        "hashed-backup-fallback": [],
        "legacy-backup-fallback": [],
        "models-cache-fallback": [],
        "runtime-selection": [],
        "provider-auth-selection": [],
      },
    },
  };
}
