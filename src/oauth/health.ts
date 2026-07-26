import { getCodexAccountHealthSnapshot } from "../codex/routing";
import { isAccountNeedsReauth } from "../codex/account-runtime-state";
import { getCodexAccountCredential, listCodexAccountIds } from "../codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { maskAccountId } from "../lib/privacy";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { loadAuthStore, peekAuthStore, peekOAuthRefreshIntent, readOAuthRefreshIntent } from "./store";
import type { ProviderAccount } from "./types";

export type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" };

export type OAuthHealthLabel =
  | "Healthy"
  | "Rate limited"
  | "Reauthentication required"
  | "Refresh failed"
  | "Metadata mismatch"
  | "Credential conflict";

export type OAuthHealthEntry = {
  provider: string;
  accountId: string;
  health: OAuthAccountHealth;
  action?: string;
};

export type OAuthAccountHealthFields = {
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
};

export type CollectOAuthHealthOptions = {
  /** Skip chmod/backup side effects when reading credential files (doctor/status). */
  observeOnly?: boolean;
  /**
   * When true (default), include Codex entries from this process's in-memory maps.
   * CLI surfaces should prefer {@link collectOAuthHealthEntriesForCli} which queries the live proxy.
   */
  includeLocalCodex?: boolean;
};

type OAuthWarningReason = "refresh_conflict" | "metadata_mismatch" | "stale_credentials";

export function projectOAuthAccountHealth(input: {
  needsReauth?: boolean;
  reauthReason?: "unauthorized" | "forbidden" | "refresh_failed";
  cooldownUntilMs?: number;
  cooldownReason?: "rate_limit" | "quota";
  warningReason?: OAuthWarningReason;
  now?: number;
}): OAuthAccountHealth {
  const now = input.now ?? Date.now();
  if (input.needsReauth) {
    return { status: "reauth_required", reason: input.reauthReason ?? "refresh_failed" };
  }
  if (
    typeof input.cooldownUntilMs === "number"
    && Number.isFinite(input.cooldownUntilMs)
    && input.cooldownUntilMs > now
  ) {
    return {
      status: "cooldown",
      until: new Date(input.cooldownUntilMs).toISOString(),
      reason: input.cooldownReason ?? "quota",
    };
  }
  if (input.warningReason) {
    return { status: "warning", reason: input.warningReason };
  }
  return { status: "healthy" };
}

/** Codex pool accounts are not a public `ocx login` provider; reauth is dashboard-driven. */
export const CODEX_REAUTH_ACTION = "reauthenticate via the dashboard Codex account pool";

function actionFor(provider: string, health: OAuthAccountHealth): string | undefined {
  if (health.status === "reauth_required") {
    if (provider === "codex") return CODEX_REAUTH_ACTION;
    return `run \`ocx login ${provider}\``;
  }
  if (health.status === "cooldown") {
    const local = new Date(health.until).toLocaleString();
    return `wait until ${local} or start a new session with another eligible account`;
  }
  if (health.status === "warning" && health.reason === "refresh_conflict") {
    return "re-run `ocx doctor` after ensuring only one proxy process writes the credential store";
  }
  return undefined;
}

export function oauthHealthLabel(health: OAuthAccountHealth): OAuthHealthLabel {
  switch (health.status) {
    case "healthy":
      return "Healthy";
    case "cooldown":
      return "Rate limited";
    case "reauth_required":
      return health.reason === "refresh_failed" ? "Refresh failed" : "Reauthentication required";
    case "warning":
      switch (health.reason) {
        case "refresh_conflict":
          return "Credential conflict";
        case "metadata_mismatch":
          return "Metadata mismatch";
        case "stale_credentials":
          return "Refresh failed";
      }
  }
}

export function oauthHealthSummary(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
  action?: string,
): string {
  const masked = maskAccountId(accountId) ?? "account-…????";
  let summary: string;
  switch (health.status) {
    case "healthy":
      summary = `${provider} ${masked}: healthy`;
      break;
    case "cooldown": {
      const why = health.reason === "rate_limit" ? "rate limited" : "quota limited";
      summary = `${provider} ${masked}: ${why} until ${health.until}. Routing for this account is paused until then.`;
      break;
    }
    case "reauth_required":
      summary = `${provider} ${masked}: reauthentication required (${health.reason.replaceAll("_", " ")}).`;
      break;
    case "warning":
      summary = `${provider} ${masked}: ${health.reason.replaceAll("_", " ")}.`;
      break;
  }
  if (action && health.status !== "healthy") {
    return `${summary} Next: ${action}`;
  }
  return summary;
}

export function oauthAccountHealthFields(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): OAuthAccountHealthFields {
  const action = actionFor(provider, health);
  return {
    health,
    healthLabel: oauthHealthLabel(health),
    healthSummary: oauthHealthSummary(provider, accountId, health, action),
    ...(action ? { healthAction: action } : {}),
  };
}

export function projectStoredOAuthAccountHealth(
  provider: string,
  account: ProviderAccount,
  now = Date.now(),
  opts: { observeOnly?: boolean } = {},
): OAuthAccountHealth {
  return projectOAuthAccountHealth({
    needsReauth: account.needsReauth === true,
    reauthReason: account.needsReauth === true ? "refresh_failed" : undefined,
    warningReason: detectOAuthWarning(provider, account, opts.observeOnly === true),
    now,
  });
}

export function projectCodexAccountHealth(input: {
  accountId: string;
  needsReauth: boolean;
  now?: number;
}): OAuthAccountHealth {
  const now = input.now ?? Date.now();
  const snap = getCodexAccountHealthSnapshot(input.accountId, now);
  return projectOAuthAccountHealth({
    needsReauth: input.needsReauth,
    reauthReason: input.needsReauth ? "refresh_failed" : undefined,
    cooldownUntilMs: snap?.cooldownUntil,
    cooldownReason: cooldownReasonFromSource(snap?.cooldownSource),
    now,
  });
}

/**
 * Incomplete credentials warning. Kiro may intentionally store an empty refresh
 * when authenticated via KIRO_ACCESS_TOKEN or a pasted access-only token.
 */
export function detectOAuthWarning(
  provider: string,
  account: ProviderAccount,
  observeOnly = false,
): OAuthWarningReason | undefined {
  const intent = observeOnly
    ? peekOAuthRefreshIntent(provider, account.id)
    : readOAuthRefreshIntent(provider, account.id);
  if (intent?.uncertain) return "refresh_conflict";
  const cred = account.credential;
  if (!cred?.access) return "stale_credentials";
  if (!cred.refresh) {
    if (provider === "kiro") return undefined;
    return "stale_credentials";
  }
  return undefined;
}

function cooldownReasonFromSource(
  source: "retry-after" | "reset-derived" | "default" | undefined,
): "rate_limit" | "quota" | undefined {
  if (!source) return undefined;
  return source === "retry-after" ? "rate_limit" : "quota";
}

function pushEntry(
  entries: OAuthHealthEntry[],
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): void {
  const action = actionFor(provider, health);
  entries.push({
    provider,
    accountId,
    health,
    ...(action ? { action } : {}),
  });
}

function collectLocalCodexEntries(now: number): OAuthHealthEntry[] {
  const entries: OAuthHealthEntry[] = [];
  const codexIds = new Set(listCodexAccountIds());
  codexIds.add(MAIN_CODEX_ACCOUNT_ID);
  for (const accountId of codexIds) {
    const snap = getCodexAccountHealthSnapshot(accountId, now);
    const needsReauth = isAccountNeedsReauth(accountId);
    const hasPoolCredential = accountId !== MAIN_CODEX_ACCOUNT_ID && getCodexAccountCredential(accountId) !== null;
    if (!hasPoolCredential && !needsReauth && !snap) continue;

    const health = projectOAuthAccountHealth({
      needsReauth,
      reauthReason: needsReauth ? "refresh_failed" : undefined,
      cooldownUntilMs: snap?.cooldownUntil,
      cooldownReason: cooldownReasonFromSource(snap?.cooldownSource),
      now,
    });
    pushEntry(entries, "codex", accountId, health);
  }
  return entries;
}

export function collectOAuthHealthEntries(
  now = Date.now(),
  opts: CollectOAuthHealthOptions = {},
): OAuthHealthEntry[] {
  const observeOnly = opts.observeOnly === true;
  const includeLocalCodex = opts.includeLocalCodex !== false;
  const entries: OAuthHealthEntry[] = [];
  const store = observeOnly ? peekAuthStore() : loadAuthStore();

  for (const [provider, set] of Object.entries(store)) {
    for (const account of set.accounts) {
      const health = projectOAuthAccountHealth({
        needsReauth: account.needsReauth === true,
        reauthReason: account.needsReauth === true ? "refresh_failed" : undefined,
        warningReason: detectOAuthWarning(provider, account, observeOnly),
        now,
      });
      pushEntry(entries, provider, account.id, health);
    }
  }

  if (includeLocalCodex) {
    for (const entry of collectLocalCodexEntries(now)) entries.push(entry);
  }

  return entries;
}

type ProxyCodexAccountHealth = {
  id: string;
  health?: OAuthAccountHealth;
  needsReauth?: boolean;
};

async function fetchCodexHealthFromLiveProxy(
  fetchImpl: typeof fetch = fetch,
  findLiveProxyImpl: typeof findLiveProxy = findLiveProxy,
): Promise<OAuthHealthEntry[] | null> {
  const live = await findLiveProxyImpl();
  if (!live) return null;
  const token = process.env.OPENCODEX_API_AUTH_TOKEN ?? loadServiceTokenFromFile(process.env);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(
      `http://${probeHostname(live.hostname)}:${live.port}/api/codex-auth/accounts`,
      { headers, signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { accounts?: ProxyCodexAccountHealth[] };
    if (!Array.isArray(json.accounts)) return null;
    const entries: OAuthHealthEntry[] = [];
    for (const account of json.accounts) {
      if (!account?.id || typeof account.id !== "string") continue;
      const health = account.health
        ?? projectOAuthAccountHealth({ needsReauth: account.needsReauth === true });
      pushEntry(entries, "codex", account.id, health);
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * CLI/doctor collector: observe-only OAuth store reads, and Codex health from the
 * running proxy process when reachable (cooldowns/reauth live in proxy memory).
 */
export async function collectOAuthHealthEntriesForCli(
  now = Date.now(),
  deps: {
    fetchImpl?: typeof fetch;
    findLiveProxyImpl?: typeof findLiveProxy;
  } = {},
): Promise<OAuthHealthEntry[]> {
  const entries = collectOAuthHealthEntries(now, { observeOnly: true, includeLocalCodex: false });
  const remote = await fetchCodexHealthFromLiveProxy(deps.fetchImpl, deps.findLiveProxyImpl);
  if (remote) {
    for (const entry of remote) entries.push(entry);
  } else {
    for (const entry of collectLocalCodexEntries(now)) entries.push(entry);
  }
  return entries;
}
