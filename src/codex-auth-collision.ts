import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { loadCodexAccountStore, refreshGrantFingerprintForToken } from "./codex-account-store";
import { extractAccountId } from "./oauth/chatgpt";

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

// ChatGPT account ids and emails are not authoritative duplicate keys:
// one user can legitimately hold both personal and business subscriptions.
// Only the local alias and exact OAuth grant material are duplicate keys.
export function checkAccountIdCollision(
  _chatgptAccountId: string,
  _email?: string | null,
  refreshToken?: string | null,
): { collision: true; reason: string } | { collision: false } {
  if (!refreshToken) return { collision: false };
  const candidateFingerprint = refreshGrantFingerprintForToken(refreshToken);
  for (const [poolId, cred] of Object.entries(loadCodexAccountStore())) {
    if (refreshGrantFingerprintForToken(cred.refreshToken) === candidateFingerprint) {
      return { collision: true, reason: `Credential is already in the pool (${poolId}).` };
    }
  }
  return { collision: false };
}
