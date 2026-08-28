import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getConfigDir } from "../config";

export function serviceApiTokenFilePath(): string {
  return join(getConfigDir(), "service-api-token");
}

/**
 * App-side service token loading (WinSW native mode has no batch wrapper to read the
 * token file into the environment). Pure: returns the token or null — the CALLER
 * assigns it to process.env.OPENCODEX_API_AUTH_TOKEN. Loads only when the env token
 * is empty and OCX_API_TOKEN_FILE names a readable file.
 */
export function loadServiceTokenFromFile(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const file = env.OCX_API_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Contents of the installed service token file. The launch wrapper always re-exports
 * this file as OPENCODEX_API_AUTH_TOKEN, so doctor and start must inspect it even
 * when the calling shell has no data-plane env var.
 * Returns the token or null — never throws, never logs the value.
 */
export function readInstalledServiceToken(): string | null {
  try {
    const token = readFileSync(serviceApiTokenFilePath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}
