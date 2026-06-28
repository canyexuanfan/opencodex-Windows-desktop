import { loadConfig, saveConfig } from "./config";
import { withCodexAccountLogLabel } from "./codex-account-label";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  saveCodexAccountCredential,
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  TokenRefreshError,
} from "./codex-account-store";
import { deleteCodexAccount } from "./codex-account-lifecycle";
import { checkAccountIdCollision, readCodexTokens } from "./codex-auth-collision";
export { checkAccountIdCollision, getMainChatgptAccountId } from "./codex-auth-collision";
export { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-account-runtime-state";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "./codex-account-runtime-state";
import {
  clearAccountQuota,
  getAccountQuota,
  listAccountQuotas,
  parseUsageQuota,
  updateAccountQuota,
  type StoredAccountQuota,
  type WhamUsageResponse,
} from "./codex-quota";
export { clearAccountQuota, getAccountQuota, parseUsageQuota, updateAccountQuota } from "./codex-quota";
import { extractAccountId, decodeJwtPayload } from "./oauth/chatgpt";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./codex-main-account";
import { maskEmail } from "./privacy";
export { maskEmail } from "./privacy";
import type { CodexAccount, OcxConfig } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";

const codexAuthLoginState = new Map<string, { status: string; accountId?: string; email?: string; error?: string; doneAt?: number }>();

function configuredPoolAccount(config: OcxConfig, accountId: string): CodexAccount | null {
  if (!ACCOUNT_ID_RE.test(accountId)) return null;
  return (config.codexAccounts ?? []).find(account => account.id === accountId && !account.isMain) ?? null;
}

function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

function quotaForPlan<T extends Omit<StoredAccountQuota, "updatedAt"> | StoredAccountQuota | null>(
  quota: T,
  plan: string | null | undefined,
): T {
  if (!quota || !isThirtyDayOnlyPlan(plan)) return quota;
  return {
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.resetCredits !== undefined ? { resetCredits: quota.resetCredits } : {}),
    ...("updatedAt" in quota ? { updatedAt: quota.updatedAt } : {}),
  } as T;
}

function poolAccountDto(
  account: CodexAccount,
  quotaResult: PoolQuotaResult,
  hasCredential: boolean,
): Record<string, unknown> {
  const quota = quotaForPlan(quotaResult.quota, account.plan);
  return {
    id: account.id,
    email: maskEmail(account.email) ?? account.email,
    ...(account.plan !== undefined ? { plan: account.plan } : {}),
    ...(account.logLabel !== undefined ? { logLabel: account.logLabel } : {}),
    isMain: false,
    quota: quota ? { ...quota } : null,
    needsReauth: !hasCredential || quotaResult.needsReauth || isAccountNeedsReauth(account.id),
    hasCredential,
  };
}

async function resolveResetCreditAuth(
  runtimeConfig: OcxConfig,
  accountId: string,
): Promise<
  | { ok: true; isMain: boolean; accessToken: string; chatgptAccountId: string }
  | { ok: false; response: Response }
> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const tokens = readCodexTokens();
    if (!tokens) return { ok: false, response: jsonResponse({ error: "Main Codex account not logged in" }, 401) };
    return { ok: true, isMain: true, accessToken: tokens.access_token, chatgptAccountId: tokens.account_id };
  }
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return { ok: false, response: jsonResponse({ error: "Invalid account id format" }, 400) };
  }
  if (!configuredPoolAccount(runtimeConfig, accountId)) {
    return { ok: false, response: jsonResponse({ error: "Unknown Codex account" }, 404) };
  }
  const cred = await getValidCodexToken(accountId);
  return { ok: true, isMain: false, accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId };
}

function safeResetCreditsDto(input: unknown): { credits: { granted_at: string; expires_at: string }[]; available_count?: number } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const rawCredits = Array.isArray(obj.credits) ? obj.credits : [];
  const credits = rawCredits.flatMap((raw): { granted_at: string; expires_at: string }[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const credit = raw as Record<string, unknown>;
    return typeof credit.granted_at === "string" && typeof credit.expires_at === "string"
      ? [{ granted_at: credit.granted_at, expires_at: credit.expires_at }]
      : [];
  });
  const rawAvailable = (obj.rate_limit_reset_credits as { available_count?: unknown } | null | undefined)?.available_count
    ?? obj.available_count;
  return {
    credits,
    ...(typeof rawAvailable === "number" && Number.isFinite(rawAvailable) ? { available_count: rawAvailable } : {}),
  };
}

function safeResetCreditConsumeDto(input: unknown): { code: string } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  return { code: typeof obj.code === "string" ? obj.code : "unknown" };
}

export function isUnverifiedCodexImportEnabled(): boolean {
  return process.env[MANUAL_IMPORT_ENV] === "1";
}

function manualImportDisabledResponse(): Response {
  return jsonResponse({
    error: "Manual Codex account import is disabled. Use OAuth login to add a pool account.",
    code: "manual_import_disabled",
  }, 403);
}

function expireCodexAuthFlow(flowId: string | null, error = "Login cancelled"): void {
  if (!flowId) return;
  codexAuthLoginState.set(flowId, { status: "error", error, doneAt: Date.now() });
  setTimeout(() => codexAuthLoginState.delete(flowId), 30_000);
}

let mainAccountCache: { email: string | null; plan: string | null; quota: Omit<StoredAccountQuota, "updatedAt"> | null; ts: number } | null = null;
const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;
const POOL_QUOTA_REFRESH_CONCURRENCY = 4;

function isRuntimeConfig(config: OcxConfig): boolean {
  return !!config && typeof config === "object" && !!config.providers;
}

function getRuntimeConfig(config: OcxConfig): OcxConfig {
  return isRuntimeConfig(config) ? config : loadConfig();
}

function saveRuntimeConfig(sourceConfig: OcxConfig, nextConfig: OcxConfig): void {
  saveConfig(nextConfig);
  if (sourceConfig === nextConfig || !isRuntimeConfig(sourceConfig)) return;
  for (const key of Object.keys(sourceConfig) as Array<keyof OcxConfig>) {
    delete sourceConfig[key];
  }
  Object.assign(sourceConfig, nextConfig);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchMainAccountInfo(forceRefresh = false): Promise<{ email: string | null; plan: string | null; quota: Omit<StoredAccountQuota, "updatedAt"> | null }> {
  if (!forceRefresh && mainAccountCache && Date.now() - mainAccountCache.ts < MAIN_CACHE_TTL) {
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
    const data = (await resp.json()) as WhamUsageResponse;
    const result = {
      email: data.email ?? null,
      plan: data.plan_type ?? null,
      quota: parseUsageQuota(data),
      ts: Date.now(),
    };
    mainAccountCache = result;
    // Mirror main quota + plan into the shared stores so the rotation engine can
    // score and auto-switch the main account exactly like a pool account (Option A).
    setMainAccountPlan(result.plan);
    if (result.quota) {
      updateAccountQuota(
        MAIN_CODEX_ACCOUNT_ID,
        result.quota.weeklyPercent,
        result.quota.fiveHourPercent,
        result.quota.weeklyResetAt,
        result.quota.fiveHourResetAt,
        result.quota.monthlyPercent,
        result.quota.monthlyResetAt,
        result.quota.resetCredits,
      );
    }
    return result;
  } catch {
    return { email: null, plan: null, quota: null };
  }
}

interface PoolQuotaResult {
  quota: StoredAccountQuota | null;
  needsReauth: boolean;
}

async function fetchPoolAccountQuota(accountId: string, forceRefresh = false, configuredPlan?: string): Promise<PoolQuotaResult> {
  const existing = getAccountQuota(accountId);
  if (!forceRefresh && existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return { quota: existing, needsReauth: false };
  }
  try {
    const { accessToken, chatgptAccountId } = await getValidCodexToken(accountId);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { quota: existing ?? null, needsReauth: resp.status === 401 };
    const data = (await resp.json()) as WhamUsageResponse;
    const quota = parseUsageQuota({ ...data, plan_type: data.plan_type ?? configuredPlan });
    if (!quota) return { quota: existing ?? null, needsReauth: false };
    updateAccountQuota(
      accountId,
      quota.weeklyPercent,
      quota.fiveHourPercent,
      quota.weeklyResetAt,
      quota.fiveHourResetAt,
      quota.monthlyPercent,
      quota.monthlyResetAt,
      quota.resetCredits,
    );
    return { quota: getAccountQuota(accountId), needsReauth: false };
  } catch (e) {
    if (e instanceof CodexCredentialGenerationConflictError || e instanceof CodexCredentialRefreshLockTimeoutError) return { quota: existing ?? null, needsReauth: false };
    if (e instanceof TokenRefreshError) return { quota: existing ?? null, needsReauth: true };
    return { quota: existing ?? null, needsReauth: false };
  }
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    const runtimeConfig = getRuntimeConfig(config);
    const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(a => !a.isMain);
    const mainInfo = await fetchMainAccountInfo(forceRefresh);
    const withQuota = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
      const cred = getCodexAccountCredential(a.id);
      const quotaResult = cred
        ? await fetchPoolAccountQuota(a.id, forceRefresh, a.plan)
        : { quota: null, needsReauth: true };
      return poolAccountDto(a, quotaResult, !!cred);
    });
    const main = {
      id: MAIN_CODEX_ACCOUNT_ID,
      email: maskEmail(mainInfo.email) ?? "Codex App login",
      plan: mainInfo.plan,
      isMain: true,
      hasCredential: true,
      quota: mainInfo.quota ? { ...quotaForPlan({ ...mainInfo.quota, updatedAt: Date.now() }, mainInfo.plan) } : null,
    };
    return jsonResponse({ accounts: [main, ...withQuota] });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    if (!isUnverifiedCodexImportEnabled()) return manualImportDisabledResponse();

    let body: { id: string; email: string; plan?: string; accessToken: string; refreshToken: string; chatgptAccountId: string };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (!body.id || !body.email || !body.accessToken || !body.refreshToken || !body.chatgptAccountId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    if (!ACCOUNT_ID_RE.test(body.id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    if (body.accessToken.length > 10_000 || body.refreshToken.length > 10_000) {
      return jsonResponse({ error: "Input too large" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    const accounts = runtimeConfig.codexAccounts ?? [];
    if (accounts.some(a => a.id === body.id) || getCodexAccountCredential(body.id)) {
      return jsonResponse({ error: `Account id already exists: ${body.id}` }, 400);
    }
    // 1.1: Duplicate check is scoped by personal vs workspace plan bucket.
    const derivedAccountId = extractAccountId(undefined, body.accessToken) ?? body.chatgptAccountId;
    const collision = checkAccountIdCollision(derivedAccountId, body.email, body.plan);
    if (collision.collision) {
      return jsonResponse({ error: collision.reason }, 400);
    }
    // 4.2: use JWT exp for expiresAt instead of hardcoded 1 hour
    const payload = decodeJwtPayload(body.accessToken);
    const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 3600_000;
    saveCodexAccountCredential(body.id, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: exp,
      chatgptAccountId: derivedAccountId,
    });
    clearAccountNeedsReauth(body.id);
    accounts.push(withCodexAccountLogLabel({ id: body.id, email: body.email, plan: body.plan, isMain: false }, accounts));
    runtimeConfig.codexAccounts = accounts;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    const runtimeConfig = getRuntimeConfig(config);
    deleteCodexAccount(runtimeConfig, id);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    let body: { accountId: string | null };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const runtimeConfig = getRuntimeConfig(config);
    if (body.accountId != null && body.accountId !== MAIN_CODEX_ACCOUNT_ID) {
      const exists = (runtimeConfig.codexAccounts ?? []).some(a => a.id === body.accountId);
      if (!exists) return jsonResponse({ error: "Account not found" }, 400);
    }
    runtimeConfig.activeCodexAccountId = body.accountId ?? undefined;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const runtimeConfig = getRuntimeConfig(config);
    return jsonResponse({
      activeCodexAccountId: runtimeConfig.activeCodexAccountId ?? null,
      autoSwitchThreshold: runtimeConfig.autoSwitchThreshold ?? 80,
      upstreamFailoverThreshold: runtimeConfig.upstreamFailoverThreshold ?? 3,
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 100) {
      return jsonResponse({ error: "Threshold must be an integer 0-100" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.autoSwitchThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/failover" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 20) {
      return jsonResponse({ error: "Threshold must be an integer 0-20" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.upstreamFailoverThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of listAccountQuotas()) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/reset-credits" && req.method === "GET") {
    const accountId = url.searchParams.get("accountId");
    if (!accountId) return jsonResponse({ error: "accountId required" }, 400);

    try {
      const auth = await resolveResetCreditAuth(getRuntimeConfig(config), accountId);
      if (!auth.ok) return auth.response;

      const resp = await fetch(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        {
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "ChatGPT-Account-Id": auth.chatgptAccountId,
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
      }
      return jsonResponse(safeResetCreditsDto(await resp.json()));
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit lookup failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);

    try {
      const auth = await resolveResetCreditAuth(getRuntimeConfig(config), body.accountId);
      if (!auth.ok) return auth.response;

      const idempotencyKey = crypto.randomUUID();
      const resp = await fetch(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "ChatGPT-Account-Id": auth.chatgptAccountId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ redeem_request_id: idempotencyKey }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
      }
      const result = safeResetCreditConsumeDto(await resp.json());
      if (result.code === "reset") {
        if (auth.isMain) {
          await fetchMainAccountInfo(true);
        } else {
          const account = configuredPoolAccount(getRuntimeConfig(config), body.accountId);
          await fetchPoolAccountQuota(body.accountId, true, account?.plan);
        }
      }
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit consume failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const requestedAccountId = body.id?.trim();
    if (requestedAccountId && !ACCOUNT_ID_RE.test(requestedAccountId)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const accountId = requestedAccountId || `chatgpt-${Date.now()}`;
    const runtimeConfig = getRuntimeConfig(config);
    if ((runtimeConfig.codexAccounts ?? []).some(a => a.id === accountId) || getCodexAccountCredential(accountId)) {
      return jsonResponse({ error: `Account id already exists: ${accountId}` }, 400);
    }
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { startLoginFlow, getLoginStatus } = await import("./oauth/index");
      const result = await startLoginFlow("chatgpt", { forceLogin: true });

      (async () => {
        let completed = false;
        for (let i = 0; i < 150; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const st = getLoginStatus("chatgpt");
          if (st.done && st.loggedIn) {
            const { getCredential } = await import("./oauth/store");
            const cred = getCredential("chatgpt");
            if (cred) {
              const oauthAccountId = cred.accountId;
              if (!oauthAccountId) {
                codexAuthLoginState.set(flowId, {
                  status: "error",
                  error: "Could not determine account identity from OAuth tokens. Please retry OAuth login.",
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              let email = cred.email || accountId;
              let plan: string | undefined;
              let quota: Omit<StoredAccountQuota, "updatedAt"> | null = null;
              try {
                const tokens = { access_token: cred.access, account_id: oauthAccountId };
                const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                  headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                  signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                  const data = (await resp.json()) as WhamUsageResponse;
                  email = data.email ?? email;
                  plan = data.plan_type ?? undefined;
                  quota = parseUsageQuota(data);
                }
              } catch { /* wham fetch is non-blocking */ }
              // 1.2: Duplicate check is scoped by personal vs workspace plan bucket.
              const collision = checkAccountIdCollision(oauthAccountId, email, plan);
              if (collision.collision) {
                codexAuthLoginState.set(flowId, {
                  status: "error", error: collision.reason, doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              saveCodexAccountCredential(accountId, {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: oauthAccountId,
              });
              clearAccountNeedsReauth(accountId);
              if (quota) {
                updateAccountQuota(
                  accountId,
                  quota.weeklyPercent,
                  quota.fiveHourPercent,
                  quota.weeklyResetAt,
                  quota.fiveHourResetAt,
                  quota.monthlyPercent,
                  quota.monthlyResetAt,
                  quota.resetCredits,
                );
              }

              const latestConfig = getRuntimeConfig(config);
              const accounts = latestConfig.codexAccounts ?? [];
              if (!accounts.find(a => a.id === accountId)) {
                accounts.push(withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts));
                latestConfig.codexAccounts = accounts;
                saveRuntimeConfig(config, latestConfig);
              }
              codexAuthLoginState.set(flowId, { status: "done", accountId, email, doneAt: Date.now() });
              completed = true;
            }
            break;
          }
          if (st.done && st.error) {
            codexAuthLoginState.set(flowId, { status: "error", error: st.error, doneAt: Date.now() });
            completed = true;
            break;
          }
        }
        if (!completed) {
          codexAuthLoginState.set(flowId, {
            status: "error",
            error: "Login timed out before OAuth completed.",
            doneAt: Date.now(),
          });
        }
        // TTL: keep completed flow state available for clients that miss a short polling window.
        setTimeout(() => codexAuthLoginState.delete(flowId), 300_000);
      })();

      codexAuthLoginState.set(flowId, { status: "pending" });
      return jsonResponse({ ok: true, flowId, url: result.url, instructions: result.instructions });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already in progress")) {
        return jsonResponse({ error: msg, status: "pending" }, 409);
      }
      return jsonResponse({ error: msg }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: string };
    const { cancelLoginFlow } = await import("./oauth/index");
    const cancelled = cancelLoginFlow("chatgpt");
    expireCodexAuthFlow(body.flowId ?? null);
    return jsonResponse({ ok: true, cancelled });
  }

  if (url.pathname === "/api/codex-auth/login-status" && req.method === "GET") {
    const flowId = url.searchParams.get("flowId");
    const accountId = url.searchParams.get("accountId")?.trim();
    if (flowId) {
      const st = codexAuthLoginState.get(flowId);
      if (!st && accountId && getCodexAccountCredential(accountId)) {
        return jsonResponse({ status: "done", accountId });
      }
      return jsonResponse(st ? { ...st, email: maskEmail(st.email) ?? undefined } : { status: "expired" });
    }
    // Legacy fallback: return latest pending flow
    for (const [, st] of codexAuthLoginState) {
      if (st.status === "pending") return jsonResponse({ ...st, email: maskEmail(st.email) ?? undefined });
    }
    return jsonResponse({ status: "idle" });
  }

  return null;
}
