import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx account login <provider> [--id <account-id>] [--reauth] [--code <redirect-or-code>]
      [--no-wait] [--json]
  ocx account code <provider> <redirect-or-code> [--flow <flow-id>] [--json]
  ocx account cancel <provider> [--flow <flow-id>] [--json]
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]`;

const CODEX_NAMES = new Set(["openai", "codex", "chatgpt"]);

interface LoginStart {
  url?: string;
  flowId?: string;
  instructions?: string;
  deviceCode?: string;
}

async function login(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  const noWait = takeFlag(args, "--no-wait");
  const reauth = takeFlag(args, "--reauth");
  const id = takeOption(args, "--id");
  const code = takeOption(args, "--code");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);

  if (CODEX_NAMES.has(provider)) {
    const start = await runtimeRequest<LoginStart>("/api/codex-auth/login", {
      method: "POST",
      body: JSON.stringify({ ...(id ? { id } : {}), ...(reauth ? { reauth: true } : {}) }),
    }, deps);
    if (!wantsJson) {
      if (start.url) console.log(`Open this URL to sign in:\n${start.url}`);
      if (start.instructions) console.log(start.instructions);
      if (start.flowId) console.log(`Flow: ${start.flowId}`);
    }
    if (code && start.flowId) {
      await runtimeRequest("/api/codex-auth/login/code", {
        method: "POST",
        body: JSON.stringify({ flowId: start.flowId, input: code }),
      }, deps);
    }
    if (noWait) {
      if (wantsJson) printData(start, true);
      return;
    }
    if (!start.flowId) throw new CliUsageError("login did not return a flow id");
    for (let attempt = 0; attempt < 150; attempt++) {
      await Bun.sleep(2_000);
      const state = await runtimeRequest<Record<string, unknown>>(
        `/api/codex-auth/login-status?flowId=${encodeURIComponent(start.flowId)}${id ? `&accountId=${encodeURIComponent(id)}` : ""}${reauth ? "&reauth=1" : ""}`,
        {}, deps,
      );
      if (state.status === "done") {
        printData(state, wantsJson, [`Logged in${state.email ? ` as ${String(state.email)}` : ""}.`]);
        return;
      }
      if (state.status === "error" || state.status === "expired") {
        throw new CliUsageError(String(state.error ?? `login ${state.status}`));
      }
    }
    throw new CliUsageError("login timed out");
  }

  if (id && !reauth) throw new CliUsageError("--id is only valid with --reauth for provider OAuth accounts", USAGE);
  const start = await runtimeRequest<LoginStart>("/api/oauth/login", {
    method: "POST",
    body: JSON.stringify({ provider, addAccount: !reauth, ...(reauth && id ? { accountId: id, reauth: true } : {}) }),
  }, deps);
  if (!wantsJson) {
    if (start.url) console.log(`Open this URL to sign in:\n${start.url}`);
    if (start.instructions) console.log(start.instructions);
    if (start.deviceCode) console.log(`Device code: ${start.deviceCode}`);
  }
  if (code) {
    await runtimeRequest("/api/oauth/login/code", {
      method: "POST",
      body: JSON.stringify({ provider, input: code }),
    }, deps);
  }
  if (noWait) {
    if (wantsJson) printData(start, true);
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(2_000);
    const state = await runtimeRequest<Record<string, unknown>>(`/api/oauth/status?provider=${encodeURIComponent(provider)}`, {}, deps);
    if (state.loggedIn === true) {
      printData(state, wantsJson, [`Logged in to ${provider}.`]);
      return;
    }
    if (state.error) throw new CliUsageError(String(state.error));
  }
  throw new CliUsageError("login timed out");
}

async function code(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const input = args.shift();
  const wantsJson = takeFlag(args, "--json");
  const flowId = takeOption(args, "--flow");
  if (!provider || !input) throw new CliUsageError("provider and redirect/code are required", USAGE);
  rejectArgs(args, USAGE);
  const path = CODEX_NAMES.has(provider) ? "/api/codex-auth/login/code" : "/api/oauth/login/code";
  if (CODEX_NAMES.has(provider) && !flowId) throw new CliUsageError("Codex login code requires --flow <flow-id>", USAGE);
  const body = CODEX_NAMES.has(provider) ? { flowId, input } : { provider, input };
  const result = await runtimeRequest(path, { method: "POST", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Login code submitted."]);
}

async function cancel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  const flowId = takeOption(args, "--flow");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);
  const codex = CODEX_NAMES.has(provider);
  const result = await runtimeRequest(codex ? "/api/codex-auth/login/cancel" : "/api/oauth/login/cancel", {
    method: "POST",
    body: JSON.stringify(codex ? { flowId } : { provider }),
  }, deps);
  printData(result, wantsJson, [`Cancelled ${provider} login.`]);
}

async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const rawId = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  if (!rawId) throw new CliUsageError("account id is required", USAGE);
  if (consume && !yes) throw new CliUsageError("consuming a reset credit requires --yes", USAGE);
  rejectArgs(args, USAGE);
  const accountId = rawId === "main" ? "__main__" : rawId;
  const result = consume
    ? await runtimeRequest("/api/codex-auth/reset-credits/consume", { method: "POST", body: JSON.stringify({ accountId }) }, deps)
    : await runtimeRequest(`/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`, {}, deps);
  printData(result, wantsJson);
}

export async function handleAccountAuthCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
  let action: (() => Promise<void>) | undefined;
  if (sub === "login" || sub === "reauth") action = () => login(sub === "reauth" ? [...argv, "--reauth"] : argv, deps);
  else if (sub === "code") action = () => code(argv, deps);
  else if (sub === "cancel") action = () => cancel(argv, deps);
  else if (sub === "reset-credits") action = () => resetCredits(argv, deps);
  if (!action) return null;
  return runCliAction(action);
}

export const ACCOUNT_AUTH_USAGE = USAGE;
