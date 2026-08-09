import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { labInstallationSaltPath, labRoot } from "../paths";

const SALT_BYTES = 32;

function readSaltFile(path: string): Uint8Array {
  const bytes = readFileSync(path);
  if (bytes.byteLength !== SALT_BYTES) {
    throw new Error("harness_failure: invalid installation salt length");
  }
  return new Uint8Array(bytes);
}

function removeStagingFile(path: string): void {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Read or atomically publish the per-installation salt used for local fingerprinting. */
export function readInstallationSalt(configDir?: string): Uint8Array {
  const path = labInstallationSaltPath(configDir);
  const root = labRoot(configDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  try { return readSaltFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // The final pathname must never become visible before all 32 bytes are durable in the
  // staging inode. A hard-link publish is atomic and fails with EEXIST when another process won.
  const stagingPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  if (dirname(stagingPath) !== dirname(path)) throw new Error("harness_failure: installation salt staging path escaped directory");
  const salt = randomBytes(SALT_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(stagingPath, "wx", 0o600);
    writeFileSync(fd, salt);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    try {
      linkSync(stagingPath, path);
      return new Uint8Array(salt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readSaltFile(path);
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close before cleanup */ }
    }
    removeStagingFile(stagingPath);
  }
}
