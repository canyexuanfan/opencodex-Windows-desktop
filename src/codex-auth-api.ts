import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { loadConfig, saveConfig } from "./config";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  saveCodexAccountCredential,
  removeCodexAccountCredential,
} from "./codex-account-store";
import type { OcxConfig } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const accountQuota = new Map<string, {
  weeklyPercent: number;
  fiveHourPercent: number;
  updatedAt: number;
}>();

export function updateAccountQuota(accountId: string, weekly: number, fiveHour: number): void {
  accountQuota.set(accountId, { weeklyPercent: weekly, fiveHourPercent: fiveHour, updatedAt: Date.now() });
}

export function getAccountQuota(accountId: string) {
  return accountQuota.get(accountId) ?? null;
}

export function clearAccountQuota(): void { accountQuota.clear(); }

const codexAuthLoginState = new Map<string, { status: string; accountId?: string; email?: string; error?: string }>();

function readCodexTokens(): { access_token: string; account_id: string } | null {
  try {
    const codexHome = process.env["CODEX_HOME"] || join(os.homedir(), ".codex");
    const authPath = join(codexHome, "auth.json");
    if (!existsSync(authPath)) return null;
    const j = JSON.parse(readFileSync(authPath, "utf-8")) as { tokens?: { access_token?: string; account_id?: string } };
    if (j?.tokens?.access_token) return { access_token: j.tokens.access_token, account_id: j.tokens.account_id ?? "" };
  } catch { /* best effort */ }
  return null;
}

let mainAccountCache: { email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null; ts: number } | null = null;
const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;

async function fetchMainAccountInfo(): Promise<{ email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null }> {
  if (mainAccountCache && Date.now() - mainAccountCache.ts < MAIN_CACHE_TTL) {
    return mainAccountCache;
  }
  const tokens = readCodexTokens();
  if (!tokens) return { email: null, plan: null, quota: null };
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { email: null, plan: null, quota: null };
    const data = (await resp.json()) as {
      email?: string | null;
      plan_type?: string | null;
      rate_limit?: {
        primary_window?: { used_percent?: number };
        secondary_window?: { used_percent?: number };
      };
    };
    const result = {
      email: data.email ?? null,
      plan: data.plan_type ?? null,
      quota: data.rate_limit ? {
        weeklyPercent: data.rate_limit.secondary_window?.used_percent ?? 0,
        fiveHourPercent: data.rate_limit.primary_window?.used_percent ?? 0,
      } : null,
      ts: Date.now(),
    };
    mainAccountCache = result;
    return result;
  } catch {
    return { email: null, plan: null, quota: null };
  }
}

async function fetchPoolAccountQuota(accountId: string): Promise<{ weeklyPercent: number; fiveHourPercent: number } | null> {
  const existing = accountQuota.get(accountId);
  if (existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return existing;
  }
  try {
    const { accessToken, chatgptAccountId } = await getValidCodexToken(accountId);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return existing ?? null;
    const data = (await resp.json()) as {
      rate_limit?: {
        primary_window?: { used_percent?: number };
        secondary_window?: { used_percent?: number };
      };
    };
    if (!data.rate_limit) return existing ?? null;
    const weekly = data.rate_limit.secondary_window?.used_percent ?? 0;
    const fiveHour = data.rate_limit.primary_window?.used_percent ?? 0;
    updateAccountQuota(accountId, weekly, fiveHour);
    return { weeklyPercent: weekly, fiveHourPercent: fiveHour };
  } catch {
    return existing ?? null;
  }
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  _config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const config = loadConfig();
    const poolAccounts = (config.codexAccounts ?? []).filter(a => !a.isMain);
    const [mainInfo, ...poolQuotas] = await Promise.all([
      fetchMainAccountInfo(),
      ...poolAccounts.map(a => fetchPoolAccountQuota(a.id)),
    ]);
    const withQuota = poolAccounts.map((a, i) => {
      const q = poolQuotas[i];
      return {
        ...a,
        quota: q ? { ...q, updatedAt: accountQuota.get(a.id)?.updatedAt ?? Date.now() } : null,
        hasCredential: !!getCodexAccountCredential(a.id),
      };
    });
    const main = {
      id: "__main__",
      email: mainInfo.email ?? "Codex App login",
      plan: mainInfo.plan,
      isMain: true,
      hasCredential: true,
      quota: mainInfo.quota ? { ...mainInfo.quota, updatedAt: Date.now() } : null,
    };
    return jsonResponse({ accounts: [main, ...withQuota] });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    const body = (await req.json()) as {
      id: string;
      email: string;
      plan?: string;
      accessToken: string;
      refreshToken: string;
      chatgptAccountId: string;
    };
    if (!body.id || !body.email || !body.accessToken || !body.refreshToken || !body.chatgptAccountId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    if (body.id.length > 64 || body.accessToken.length > 10_000 || body.refreshToken.length > 10_000) {
      return jsonResponse({ error: "Input too large" }, 400);
    }
    saveCodexAccountCredential(body.id, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: body.chatgptAccountId,
    });
    const config = loadConfig();
    const accounts = config.codexAccounts ?? [];
    if (!accounts.find(a => a.id === body.id)) {
      accounts.push({ id: body.id, email: body.email, plan: body.plan, isMain: false });
      config.codexAccounts = accounts;
      saveConfig(config);
    }
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    removeCodexAccountCredential(id);
    const config = loadConfig();
    config.codexAccounts = (config.codexAccounts ?? []).filter(a => a.id !== id);
    if (config.activeCodexAccountId === id) config.activeCodexAccountId = undefined;
    saveConfig(config);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    const body = (await req.json()) as { accountId: string | null };
    const config = loadConfig();
    config.activeCodexAccountId = body.accountId ?? undefined;
    saveConfig(config);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const config = loadConfig();
    return jsonResponse({
      activeCodexAccountId: config.activeCodexAccountId ?? null,
      autoSwitchThreshold: config.autoSwitchThreshold ?? 80,
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    const body = (await req.json()) as { threshold: number };
    const config = loadConfig();
    config.autoSwitchThreshold = body.threshold;
    saveConfig(config);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of accountQuota) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const accountId = body.id?.trim() || `chatgpt-${Date.now()}`;
    try {
      const { startLoginFlow, getLoginStatus } = await import("./oauth/index");
      const result = await startLoginFlow("chatgpt");

      // Background: when OAuth completes, register the account in codex-accounts pool
      (async () => {
        // Poll until the login flow completes (max 5 min)
        for (let i = 0; i < 150; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const st = getLoginStatus("chatgpt");
          if (st.loggedIn) {
            const { getCredential } = await import("./oauth/store");
            const cred = getCredential("chatgpt");
            if (cred) {
              // Fetch account info
              let email = cred.email || accountId;
              let plan: string | undefined;
              try {
                const tokens = { access_token: cred.access, account_id: cred.accountId ?? "" };
                const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                  headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                  signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                  const data = (await resp.json()) as { email?: string; plan_type?: string };
                  email = data.email ?? email;
                  plan = data.plan_type ?? undefined;
                }
              } catch (e) {
                const whamErr = e instanceof Error ? e.message : String(e);
                codexAuthLoginState.set("chatgpt", {
                  status: "done", accountId, email,
                  error: `Account info fetch failed (non-blocking): ${whamErr}`,
                });
              }

              // Save to codex-accounts store
              saveCodexAccountCredential(accountId, {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: cred.accountId ?? "",
              });

              // Add to config
              const config = loadConfig();
              const accounts = config.codexAccounts ?? [];
              if (!accounts.find(a => a.id === accountId)) {
                accounts.push({ id: accountId, email, plan, isMain: false });
                config.codexAccounts = accounts;
                saveConfig(config);
              }
              codexAuthLoginState.set("chatgpt", { status: "done", accountId, email });
            }
            break;
          }
          const errSt = getLoginStatus("chatgpt");
          if (errSt.error) {
            codexAuthLoginState.set("chatgpt", { status: "error", error: errSt.error });
            break;
          }
        }
      })();

      codexAuthLoginState.set("chatgpt", { status: "pending" });
      return jsonResponse({ ok: true, url: result.url, instructions: result.instructions });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already in progress")) {
        return jsonResponse({ error: msg, status: "pending" }, 409);
      }
      return jsonResponse({ error: msg }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login-status" && req.method === "GET") {
    const st = codexAuthLoginState.get("chatgpt");
    return jsonResponse(st ?? { status: "idle" });
  }

  return null;
}
