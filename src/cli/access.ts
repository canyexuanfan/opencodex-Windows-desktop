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
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`;

/**
 * Render the key table with the usage fields the API already returns (#2705).
 *
 * `usage` is a DISCRIMINATED UNION server-side (`api-key-usage.ts`): the `{ambiguous:true}`
 * variant carries no numbers at all, because when two config entries share an id there IS no
 * per-key total. The union exists specifically so a consumer cannot print a number beside an
 * ambiguity marker, so this renders the word `ambiguous` across the numeric columns rather
 * than a fabricated 0 -- reporting 0 requests for a key that may be in heavy use is the
 * dangerous answer to hand someone deciding what to delete.
 *
 * `attributionSince` and `historyTruncated` describe the DATA SET, not a key, so they print
 * once as a footer. Without `attributionSince`, an absent `lastUsedAt` is unreadable: it
 * could mean "never used" or "nothing is attributable yet".
 */
function formatKeyRows(payload: Record<string, unknown>, keys: Array<Record<string, unknown>>): string[] {
  const cells: string[][] = [["ID", "NAME", "PREFIX", "REQ 7D", "TOTAL", "LAST USED"]];
  for (const entry of keys) {
    const usage = (entry.usage ?? {}) as Record<string, unknown>;
    const ambiguous = usage.ambiguous === true;
    const num = (value: unknown): string => (typeof value === "number" ? value.toLocaleString("en-US") : "-");
    cells.push([
      String(entry.id ?? ""),
      String(entry.name ?? ""),
      String(entry.prefix ?? ""),
      // One marker spanning both numeric columns: the union guarantees neither exists.
      ambiguous ? "ambiguous" : num(usage.requests7d),
      ambiguous ? "" : num(usage.totalRequests),
      ambiguous ? "" : (typeof usage.lastUsedAt === "string" ? usage.lastUsedAt : "never"),
    ]);
  }
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map(row => (row[column] ?? "").length)));
  const lines = cells.map(row => row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
  const footer: string[] = [];
  if (typeof payload.attributionSince === "string") {
    footer.push(`attribution since ${payload.attributionSince}`);
  }
  if (payload.historyTruncated === true) {
    footer.push("older history truncated");
  }
  if (keys.some(entry => (entry.usage as Record<string, unknown> | undefined)?.ambiguous === true)) {
    footer.push("ambiguous: two configured keys share an id, so per-key totals do not exist");
  }
  return footer.length > 0 ? [...lines, "", ...footer] : lines;
}

async function key(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const keys = Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [];
    printData(result, wantsJson, keys.length ? formatKeyRows(result, keys) : ["No API access keys configured."]);
    return;
  }
  if (action === "create") {
    const name = args.shift() ?? "default";
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, deps);
    // The plaintext key is returned once. Keep text output explicit so callers know to store it.
    printData(result, wantsJson, [
      `Created API key ${String(result.name ?? name)} (${String(result.id ?? "")}).`,
      `Key (shown once): ${String(result.key ?? "")}`,
    ]);
    return;
  }
  if (action === "remove" || action === "delete") {
    const id = args.shift();
    const yes = takeFlag(args, "--yes");
    if (!id) throw new CliUsageError("key id is required", USAGE);
    if (!yes) throw new CliUsageError("remove requires --yes", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/keys", { method: "DELETE", body: JSON.stringify({ id }) }, deps);
    printData(result, wantsJson, [`Removed API key ${id}.`]);
    return;
  }
  throw new CliUsageError(`unknown key command ${action}`, USAGE);
}

async function endpoints(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
  const view = Object.fromEntries(Object.entries(result).filter(([key]) => key.endsWith("Endpoint") || key === "baseUrl" || key === "endpoint"));
  printData(view, wantsJson, Object.entries(view).map(([name, value]) => `${name}: ${String(value)}`));
}

async function models(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/v1/models", {}, deps);
  const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
  printData(result, wantsJson, rows.map(row => `${String(row.id)}  ${String(row.owned_by ?? "")}`.trimEnd()));
}

async function testModel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const model = args.shift();
  const wantsJson = takeFlag(args, "--json");
  const protocol = takeOption(args, "--protocol") ?? "chat";
  if (!model) throw new CliUsageError("model is required", USAGE);
  if (!(["chat", "responses", "messages"] as const).includes(protocol as "chat" | "responses" | "messages")) {
    throw new CliUsageError("--protocol must be chat, responses, or messages", USAGE);
  }
  rejectArgs(args, USAGE);
  const request = protocol === "responses"
    ? { path: "/v1/responses", body: { model, input: "Reply with OK.", max_output_tokens: 16 } }
    : protocol === "messages"
      ? { path: "/v1/messages", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 } }
      : { path: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16, stream: false } };
  const result = await runtimeRequest(request.path, { method: "POST", body: JSON.stringify(request.body) }, deps);
  printData(result, wantsJson, [`${model}: ${protocol} request succeeded.`]);
}

export async function handleAccessCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "key", ...rest] = argv;
    if (sub === "key" || sub === "keys") await key(rest, deps);
    else if (sub === "endpoints") await endpoints(rest, deps);
    else if (sub === "models") await models(rest, deps);
    else if (sub === "test") await testModel(rest, deps);
    else throw new CliUsageError(`unknown access command ${sub}`, USAGE);
  });
}

export const ACCESS_USAGE = USAGE;
