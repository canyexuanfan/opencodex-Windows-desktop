import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, hardenConfigDir, hardenExistingSecret } from "./config";
import type { CodexAccountCredentials } from "./types";

const CODEX_ACCOUNTS_PATH = join(getConfigDir(), "codex-accounts.json");
type CodexAccountStore = Record<string, CodexAccountCredentials>;

const REFRESH_SKEW_MS = 60_000;

export function loadCodexAccountStore(): CodexAccountStore {
  hardenConfigDir();
  hardenExistingSecret(CODEX_ACCOUNTS_PATH);
  if (!existsSync(CODEX_ACCOUNTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CODEX_ACCOUNTS_PATH, "utf-8")) as CodexAccountStore;
  } catch {
    return {};
  }
}

function persist(store: CodexAccountStore): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(CODEX_ACCOUNTS_PATH, JSON.stringify(store, null, 2) + "\n");
}

export function getCodexAccountCredential(id: string): CodexAccountCredentials | null {
  return loadCodexAccountStore()[id] ?? null;
}

export function saveCodexAccountCredential(id: string, cred: CodexAccountCredentials): void {
  const store = loadCodexAccountStore();
  store[id] = cred;
  persist(store);
}

export function removeCodexAccountCredential(id: string): void {
  const store = loadCodexAccountStore();
  delete store[id];
  persist(store);
}

export function listCodexAccountIds(): string[] {
  return Object.keys(loadCodexAccountStore());
}

const CHATGPT_TOKEN_URL = "https://auth0.openai.com/oauth/token";
const CHATGPT_CLIENT_ID = "DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD";

type CodexTokenResult = { accessToken: string; chatgptAccountId: string };
const refreshLocks = new Map<string, Promise<CodexTokenResult>>();

export async function getValidCodexToken(id: string): Promise<CodexTokenResult> {
  const existing = refreshLocks.get(id);
  if (existing) return existing;

  const cred = getCodexAccountCredential(id);
  if (!cred) throw new Error(`Codex account not found: ${id}`);

  if (cred.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return { accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId };
  }

  const refreshPromise = (async (): Promise<CodexTokenResult> => {
    try {
      const res = await fetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CHATGPT_CLIENT_ID,
          refresh_token: cred.refreshToken,
        }),
      });
      if (!res.ok) throw new Error(`Token refresh failed for ${id}: ${res.status}`);
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };

      const updated: CodexAccountCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? cred.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        chatgptAccountId: cred.chatgptAccountId,
      };
      saveCodexAccountCredential(id, updated);
      return { accessToken: updated.accessToken, chatgptAccountId: updated.chatgptAccountId };
    } finally {
      refreshLocks.delete(id);
    }
  })();

  refreshLocks.set(id, refreshPromise);
  return refreshPromise;
}
