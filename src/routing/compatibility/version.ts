import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../../lab/digest";

const VERSION_DOMAIN = "ocx-lab:compatibility-version:v1";
let cachedVersion: string | null = null;

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function hashManifest(manifest: unknown): string {
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode(`${VERSION_DOMAIN}\0`));
  hash.update(new TextEncoder().encode(jcsStringify(manifest)));
  return hash.digest("hex");
}

function readEmbeddedManifest(): unknown | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "generated", "compatibility-version.json"),
    join(import.meta.dir, "..", "..", "..", "src", "generated", "compatibility-version.json"),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * OpenCodex compatibility version for route subject identity.
 * Prefer embedded manifest; fall back to a conservative runtime manifest.
 */
export function readOpenCodexCompatibilityVersion(): string {
  const override = process.env.OCX_COMPATIBILITY_VERSION?.trim();
  if (override && isSha256Hex(override)) return override;

  if (cachedVersion) return cachedVersion;

  const embedded = readEmbeddedManifest();
  if (embedded) {
    cachedVersion = hashManifest(embedded);
    return cachedVersion;
  }

  cachedVersion = hashManifest({
    schemaVersion: 1,
    assertionDslVersion: "1.0.0",
    evidenceSchemaVersion: "1.0.0",
    bunRuntimeVersion: Bun.version,
    files: [],
  });
  return cachedVersion;
}

/** Test-only reset of the compatibility version memo. */
export function resetCompatibilityVersionCacheForTests(): void {
  cachedVersion = null;
}
