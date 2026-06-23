import { loadConfig, saveConfig } from "./config";
import {
  getCodexAccountCredential,
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

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  _config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const config = loadConfig();
    const accounts = config.codexAccounts ?? [];
    const withQuota = accounts.map(a => ({
      ...a,
      quota: getAccountQuota(a.id),
      hasCredential: !!getCodexAccountCredential(a.id),
    }));
    return jsonResponse({ accounts: withQuota });
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

  return null;
}
