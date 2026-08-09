import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { labInstallationSaltPath, labRoot } from "../paths";

const SALT_BYTES = 32;

/** Read or create the per-installation salt used for local fingerprinting. */
export function readInstallationSalt(configDir?: string): Uint8Array {
  const path = labInstallationSaltPath(configDir);
  const readExisting = (): Uint8Array => {
    const bytes = readFileSync(path);
    if (bytes.byteLength !== SALT_BYTES) {
      throw new Error("harness_failure: invalid installation salt length");
    }
    return new Uint8Array(bytes);
  };

  mkdirSync(labRoot(configDir), { recursive: true, mode: 0o700 });
  const salt = randomBytes(SALT_BYTES);
  try {
    writeFileSync(path, salt, { mode: 0o600, flag: "wx" });
    return new Uint8Array(salt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readExisting();
  }
}
