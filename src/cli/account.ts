/**
 * `ocx account` — list and switch Codex pool accounts, OAuth accounts and
 * API-key pools (GUI parity, issue #180).
 * Design: devlog/_plan/260720_issue180_cli_account_parity/010_account_cli_core.md
 *
 * Subcommands:
 *   list [provider] [--json] [--all]        List accounts/keys (masked only)
 *   current <provider> [--json]             Show the active account/key
 *   use <provider> <id|main> [--json]       Switch the active credential
 */
import { loadConfig } from "../config";
import { isPublicOAuthProvider } from "../oauth/index";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { apiJson, fetchRows, resolveBaseUrl, type ApiResult } from "./account-api";

export type AccountType = "codex" | "oauth" | "api-key";

export interface AccountRow {
  provider: string;
  type: AccountType;
  id: string;
  label?: string;
  email?: string;
  plan?: string;
  masked?: string;
  active: boolean;
  needsReauth?: boolean;
}

export interface AccountDeps {
  /** Test injection: skip findLiveProxy and call the API at this base URL. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  loadConfigImpl?: () => OcxConfig;
}

export type ClassifyResult = { type: AccountType } | { error: string };

const MAIN_ALIAS = "main";
const MAIN_CODEX_ID = "__main__";
/** Replacement-style single-slot OAuth (no stable identity; not HTTP-derivable). */
const REPLACEMENT_STYLE_OAUTH = new Set(["kiro"]);

const ACCOUNT_USAGE = `Usage:
  ocx account list [provider] [--json] [--all]
  ocx account current <provider> [--json]
  ocx account use <provider> <account-or-key-id|main> [--json]

List and switch provider accounts and API-key pools (masked output only).
'main' selects the Codex App login for the openai account pool.`;

// ---------------------------------------------------------------------------
// Arg helpers (same local-copy convention as provider.ts / models.ts)
// ---------------------------------------------------------------------------

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Returns an error message for leftover args, or null when clean. */
function leftoverArgsError(args: string[]): string | null {
  if (args.length === 0) return null;
  const unknown = args.filter(a => a.startsWith("-"));
  return unknown.length > 0
    ? `Unknown flag(s): ${unknown.join(", ")}`
    : `Unexpected argument(s): ${args.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Provider classification (config-first; mirrors isKeyAuthProvider + the GUI's
// providerAuthSurface — see 010 audit fold R1#1)
// ---------------------------------------------------------------------------

export function classifyAccount(config: OcxConfig, name: string): ClassifyResult {
  const provider = config.providers?.[name];
  if (providerCodexAccountMode(name, provider)) return { type: "codex" };
  const entry = getProviderRegistryEntry(name);
  if (entry?.authKind === "local") {
    return { error: `provider "${name}" is a local provider and has no credentials` };
  }
  if (provider?.authMode === "forward") {
    return { error: `provider "${name}" uses forward auth and has no switchable credentials` };
  }
  if (provider?.authMode === "key") return { type: "api-key" };
  if (provider && !provider.authMode && (provider.apiKey || (provider.apiKeyPool?.length ?? 0) > 0)) {
    return { type: "api-key" };
  }
  if (isPublicOAuthProvider(name)) return { type: "oauth" };
  if (provider) return { type: "api-key" };
  return { error: `unknown provider "${name}"` };
}

function candidateNames(config: OcxConfig): string {
  const names = new Set<string>(["openai"]);
  for (const n of Object.keys(config.providers ?? {})) names.add(n);
  return [...names].join(", ");
}

function proxyUnreachable(): number {
  console.error("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  return 1;
}

function apiError(json: Record<string, unknown>, fallback: string): number {
  const message = typeof json.error === "string" ? json.error : fallback;
  console.error(`Error: ${message}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function displayId(id: string): string {
  return id === MAIN_CODEX_ID ? MAIN_ALIAS : id;
}

function statusText(row: AccountRow): string {
  const parts: string[] = [];
  if (row.active) parts.push(row.type === "codex" ? "next session" : "active");
  if (row.needsReauth) parts.push("needs-reauth");
  return parts.join(" ");
}

export function formatAccountTable(rows: AccountRow[]): string {
  const header = ["PROVIDER", "TYPE", "ID", "PLAN/LABEL", "STATUS"];
  const data = rows.map(r => [r.provider, r.type, displayId(r.id), r.label ?? "-", statusText(r)]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map(d => d[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...data.map(line)].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdList(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const showAll = consumeFlag(rest, "--all");
  const name = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (leftover) {
    console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  const targets: { name: string; type: AccountType }[] = [];
  if (name) {
    const c = classifyAccount(config, name);
    if ("error" in c) {
      console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
      return 1;
    }
    targets.push({ name, type: c.type });
  } else {
    const seen = new Set<string>();
    const push = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      const c = classifyAccount(config, n);
      if ("error" in c) return; // fan-out silently skips no-credential providers
      targets.push({ name: n, type: c.type });
    };
    push("openai");
    const providersRes = await apiJson(deps, baseUrl, "GET", "/api/oauth/providers");
    if (providersRes.status === 0) return proxyUnreachable();
    if (providersRes.status === 200 && Array.isArray(providersRes.json.providers)) {
      for (const p of providersRes.json.providers as string[]) push(p);
    }
    for (const n of Object.keys(config.providers ?? {})) push(n);
  }

  const rows: AccountRow[] = [];
  const notes: string[] = [];
  for (const t of targets) {
    const r = await fetchRows(deps, baseUrl, t.name, t.type);
    if (r.networkDown) return proxyUnreachable();
    if (r.errorJson) {
      if (name) return apiError(r.errorJson, `failed to list ${t.name}`);
      continue; // fan-out tolerates a provider the proxy does not know
    }
    if (r.rows.length === 0) {
      if (showAll) notes.push(`${t.name}: no stored accounts or keys`);
      continue;
    }
    rows.push(...r.rows);
    if (t.type === "codex") {
      if (r.activeId === null) notes.push("openai: auto (no pin — lowest-usage account is selected per request)");
      if (providerCodexAccountMode("openai", config.providers?.openai) === "direct") {
        notes.push("openai is in direct mode — the selection takes effect when pool mode is enabled");
      }
    }
    if (t.type === "oauth" && REPLACEMENT_STYLE_OAUTH.has(t.name)) {
      notes.push(`${t.name}: single login slot — re-login replaces the current account`);
    }
  }

  if (wantsJson) {
    console.log(JSON.stringify({ accounts: rows, notes }, null, 2));
    return 0;
  }
  if (rows.length > 0) console.log(formatAccountTable(rows));
  for (const n of notes) console.log(n);
  if (rows.length === 0 && notes.length === 0) console.log("No stored accounts or keys.");
  return 0;
}

async function cmdCurrent(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const name = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (!name || leftover) {
    if (leftover) console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const c = classifyAccount(config, name);
  if ("error" in c) {
    console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const r = await fetchRows(deps, baseUrl, name, c.type);
  if (r.networkDown) return proxyUnreachable();
  if (r.errorJson) return apiError(r.errorJson, `failed to read ${name}`);

  const activeRow = r.rows.find(row => row.active) ?? null;
  if (wantsJson) {
    console.log(JSON.stringify({
      provider: name,
      type: c.type,
      activeId: r.activeId,
      autoSwitchThreshold: r.autoSwitchThreshold,
      account: activeRow,
    }, null, 2));
    return 0;
  }
  if (activeRow) {
    console.log(formatAccountTable([activeRow]));
  } else if (c.type === "codex" && r.activeId === null) {
    console.log("openai: auto (no pin — lowest-usage account is selected per request)");
  } else {
    console.log(`${name}: no active account or key`);
  }
  return 0;
}

async function cmdUse(rest: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = consumeFlag(rest, "--json");
  const name = rest.shift();
  const id = rest.shift();
  const leftover = leftoverArgsError(rest);
  if (!name || !id || leftover) {
    if (leftover) console.error(leftover);
    console.error(ACCOUNT_USAGE);
    return 1;
  }
  const config = deps.loadConfigImpl?.() ?? loadConfig();
  const c = classifyAccount(config, name);
  if ("error" in c) {
    console.error(`Error: ${c.error}. Known candidates: ${candidateNames(config)}`);
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  let res: ApiResult;
  let activeId: string;
  if (c.type === "codex") {
    activeId = id === MAIN_ALIAS ? MAIN_CODEX_ID : id;
    res = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/active", { accountId: activeId });
  } else if (c.type === "oauth") {
    activeId = id;
    res = await apiJson(deps, baseUrl, "PUT", "/api/oauth/accounts/active", { provider: name, accountId: id });
  } else {
    activeId = id;
    res = await apiJson(deps, baseUrl, "PUT", "/api/providers/keys/active", { name, id });
  }
  if (res.status === 0) return proxyUnreachable();
  if (res.status !== 200) return apiError(res.json, `failed to switch ${name}`);

  if (wantsJson) console.log(JSON.stringify({ ok: true, provider: name, type: c.type, activeId }, null, 2));
  else console.log(`${name}: active ${c.type === "api-key" ? "key" : "account"} is now ${displayId(activeId)}`);
  if (c.type === "codex") {
    console.error("Applies to new Codex sessions; running threads keep their current account.");
    const active = await apiJson(deps, baseUrl, "GET", "/api/codex-auth/active");
    if (active.status === 200 && typeof active.json.autoSwitchThreshold === "number" && active.json.autoSwitchThreshold > 0) {
      console.error(`Note: auto-switch (threshold ${active.json.autoSwitchThreshold}%) may override this pin.`);
    }
  }
  return 0;
}

export async function cmdAccount(args: string[], deps: AccountDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "list") return await cmdList(rest, deps);
    if (sub === "current") return await cmdCurrent(rest, deps);
    if (sub === "use") return await cmdUse(rest, deps);
    console.error(ACCOUNT_USAGE);
    return 1;
  } catch (err) {
    console.error(`account: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
