/**
 * Local token auto-detection — reads an existing Grok CLI credential (~/.grok/auth.json).
 * Read-only: never writes to external credential stores.
 * Ported from jawcode packages/ai/src/utils/oauth/local-token-detect.ts (xAI portion).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    const accessToken = entry.key as string;
    const refreshToken = entry.refresh_token as string;
    const expiresAt = entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0;

    return {
      refresh: refreshToken,
      access: accessToken,
      expires: expiresAt,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

/** Read the Claude Code OAuth credential from macOS Keychain. Windows/Linux: use `ocx login`. */
function readClaudeSecureStorage(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execSync(`security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -w`, {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function detectClaudeCodeToken(): OAuthCredentials | null {
  const raw = readClaudeSecureStorage();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const o = data.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    return { access: o.accessToken, refresh: o.refreshToken, expires: o.expiresAt ?? 0, source: "local-cli" };
  } catch {
    return null;
  }
}
