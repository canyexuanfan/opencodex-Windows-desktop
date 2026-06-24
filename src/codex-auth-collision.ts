import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { getCodexAccountCredential, listCodexAccountIds } from "./codex-account-store";
import { loadConfig } from "./config";
import { extractAccountId, extractEmail } from "./oauth/chatgpt";

export function readCodexTokens(): { access_token: string; account_id: string; id_token?: string } | null {
  try {
    const codexHome = process.env["CODEX_HOME"] || join(os.homedir(), ".codex");
    const authPath = join(codexHome, "auth.json");
    if (!existsSync(authPath)) return null;
    const j = JSON.parse(readFileSync(authPath, "utf-8")) as {
      tokens?: { access_token?: string; account_id?: string; id_token?: string };
    };
    if (!j?.tokens?.access_token) return null;
    return {
      access_token: j.tokens.access_token,
      account_id: j.tokens.account_id ?? "",
      id_token: j.tokens.id_token,
    };
  } catch { return null; }
}

export function getMainChatgptAccountId(): string | null {
  const tokens = readCodexTokens();
  if (!tokens) return null;
  return extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
}

function getMainChatgptEmail(): string | null {
  const tokens = readCodexTokens();
  if (!tokens) return null;
  return extractEmail(tokens.id_token, tokens.access_token) ?? null;
}

function normalizedEmail(email: string | undefined | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
}

function poolEmailForId(id: string): string | null {
  const account = (loadConfig().codexAccounts ?? []).find(a => a.id === id);
  return normalizedEmail(account?.email);
}

// Business/Team members can share chatgpt_account_id, so require email match too.
export function checkAccountIdCollision(
  chatgptAccountId: string,
  email?: string | null,
): { collision: true; reason: string } | { collision: false } {
  const candidateEmail = normalizedEmail(email);
  const mainId = getMainChatgptAccountId();
  const mainEmail = getMainChatgptEmail();
  if (mainId && mainId === chatgptAccountId && (!candidateEmail || !mainEmail || mainEmail === candidateEmail)) {
    return { collision: true, reason: "This account is your main Codex login. Use a different account for the pool." };
  }
  for (const poolId of listCodexAccountIds()) {
    const cred = getCodexAccountCredential(poolId);
    const poolEmail = poolEmailForId(poolId);
    if (cred && cred.chatgptAccountId === chatgptAccountId && (!candidateEmail || !poolEmail || poolEmail === candidateEmail)) {
      return { collision: true, reason: `Account is already in the pool (${poolId}).` };
    }
  }
  return { collision: false };
}
