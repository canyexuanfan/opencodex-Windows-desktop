import { getCodexAccountHealthSnapshot } from "../codex/routing";
import { isAccountNeedsReauth } from "../codex/account-runtime-state";
import { getCodexAccountCredential, listCodexAccountIds } from "../codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { loadAuthStore, readOAuthRefreshIntent } from "./store";
import type { ProviderAccount } from "./types";

export type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" };

export type OAuthHealthEntry = {
  provider: string;
  accountId: string;
  health: OAuthAccountHealth;
  action?: string;
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

function actionFor(provider: string, health: OAuthAccountHealth): string | undefined {
  if (health.status === "reauth_required") {
    return `run \`ocx auth login ${provider}\``;
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

function detectOAuthWarning(provider: string, account: ProviderAccount): OAuthWarningReason | undefined {
  const intent = readOAuthRefreshIntent(provider, account.id);
  if (intent?.uncertain) return "refresh_conflict";
  const cred = account.credential;
  if (!cred?.access || !cred?.refresh) return "stale_credentials";
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

export function collectOAuthHealthEntries(now = Date.now()): OAuthHealthEntry[] {
  const entries: OAuthHealthEntry[] = [];
  const store = loadAuthStore();

  for (const [provider, set] of Object.entries(store)) {
    for (const account of set.accounts) {
      const health = projectOAuthAccountHealth({
        needsReauth: account.needsReauth === true,
        reauthReason: account.needsReauth === true ? "refresh_failed" : undefined,
        warningReason: detectOAuthWarning(provider, account),
        now,
      });
      pushEntry(entries, provider, account.id, health);
    }
  }

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
