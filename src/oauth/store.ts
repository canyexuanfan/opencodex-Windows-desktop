/** OAuth token store at ~/.opencodex/auth.json, keyed by provider name. */
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
import type { OAuthCredentials } from "./types";

type AuthStore = Record<string, OAuthCredentials>;

function authPath(): string {
  return join(getConfigDir(), "auth.json");
}

export function loadAuthStore(): AuthStore {
  const path = authPath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AuthStore;
  } catch {
    backupInvalidConfig(path);
    return {};
  }
}

function persist(store: AuthStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(authPath(), JSON.stringify(store, null, 2) + "\n");
}

function normalizeCredential(cred: OAuthCredentials): OAuthCredentials {
  const normalized: OAuthCredentials = {
    access: cred.access,
    refresh: cred.refresh,
    expires: cred.expires,
  };
  if (cred.email) normalized.email = cred.email;
  if (cred.accountId) normalized.accountId = cred.accountId;
  if (cred.source) normalized.source = cred.source;
  return normalized;
}

export function getCredential(provider: string): OAuthCredentials | null {
  return loadAuthStore()[provider] ?? null;
}

export function saveCredential(provider: string, cred: OAuthCredentials): void {
  const store = loadAuthStore();
  store[provider] = normalizeCredential(cred);
  persist(store);
}

export function removeCredential(provider: string): void {
  const store = loadAuthStore();
  delete store[provider];
  persist(store);
}
