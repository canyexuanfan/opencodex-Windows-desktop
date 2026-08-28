/**
 * What `ocx` can do, as data an agent can read without parsing help text.
 *
 * This is the machine-readable index behind `ocx capabilities`. It relates each CLI
 * capability to the management route(s) it drives, which nothing in this repository did
 * before: help lived in twenty per-module `USAGE` constants and a hand-written banner
 * that a test explicitly licensed to drift from the command registry.
 *
 * LEAF MODULE. It imports nothing from `src/cli/`, and nothing here may import a command
 * module. That is not tidiness. Each command module declares its usage text as a
 * top-level `const USAGE`, evaluated at import time, so a cycle back into this table
 * would resolve to `undefined` under ESM rather than throwing -- silently emptying the
 * usage text that `rejectArgs` hands to `CliUsageError`, in the exact error-reporting
 * surface the CLI-operability issues are about. `tests/cli-capabilities.test.ts` asserts
 * the absence of those imports and that every rendered usage string is non-empty, so the
 * failure mode is loud instead of degraded.
 *
 * Head-handled surfaces (`--version`, `help`) are declared separately in
 * `HEAD_CAPABILITIES`. They exit in the CLI head (`root.ts`) before dispatch and have no
 * runner key, so listing them as ordinary capabilities would break the registry parity
 * assertion that every canonical entry is a direct runner. `help` is excluded from
 * `CLI_COMMANDS` deliberately -- `tests/cli-registry.test.ts` documents it as a
 * head-handled pseudo-case -- and that decision is preserved here rather than reversed.
 */

/** A management route a capability drives. Path text only; never a handler reference. */
export interface CapabilityRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface CapabilityFlag {
  readonly name: string;
  readonly value?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly summary: string;
}

/**
 * How a capability emits JSON.
 *
 * - `payload`: the API payload, largely unwrapped.
 * - `envelope`: a CLI-shaped object with its own schema.
 * - `none`: no `--json` mode.
 */
export type CapabilityJsonMode = "payload" | "envelope" | "none";

export interface Capability {
  /** Command path, e.g. `["account", "pause"]`. */
  readonly command: readonly string[];
  readonly summary: string;
  readonly routes: readonly CapabilityRoute[];
  readonly flags: readonly CapabilityFlag[];
  readonly mutates: boolean;
  readonly json: CapabilityJsonMode;
  readonly details?: readonly string[];
  /**
   * Extra banner rows this capability owns, for surfaces the banner shows separately
   * from the bare command (`ocx restore back`, `ocx doctor --reclaim-response-temps`).
   * Without this the banner cannot equal the capability set: it legitimately carries more
   * rows than there are commands.
   */
  readonly bannerLines?: readonly string[];
}

/**
 * Surfaces resolved in the CLI head, before dispatch.
 *
 * They belong in `ocx capabilities` output and in the banner, but not in `CLI_COMMANDS`:
 * `--version`, `-v`, and `version` are answered at `root.ts` and exit, so none of them is
 * a runner key to parity-check against.
 */
export interface HeadCapability {
  readonly invocations: readonly string[];
  readonly summary: string;
  readonly bannerLine: string;
}

export const HEAD_CAPABILITIES: readonly HeadCapability[] = [
  {
    invocations: ["--version", "-v", "version"],
    summary: "Print the CLI version and exit.",
    bannerLine: "ocx --version | -v          Print version",
  },
  {
    invocations: ["help", "--help", "-h"],
    summary: "Print the command list, or one command's usage with `ocx help <command>`.",
    bannerLine: "ocx help [command]          Show help for a command",
  },
];

/**
 * Capabilities declared so far. Incomplete by design: later phases add verbs.
 * `ocx capabilities` is the index of what is listed here, not of every CLI command.
 * A capability must not name a route the command does not actually fetch.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    command: ["status"],
    summary: "Proxy status, injection state, and version skew between this CLI and the running proxy.",
    // No management route: `collectStatus` identity-probes `/healthz` through
    // `findLiveProxy` and reads local config. Declaring `GET /api/status` here was wrong
    // -- that route does not exist, and the registry cross-check caught it.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the status envelope as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads /healthz plus local config; drives no management API route."],
  },
  {
    command: ["capabilities"],
    summary: "List the declared CLI capabilities and the management routes they drive.",
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the full capability table as JSON." },
      { name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state." },
      { name: "--route", value: "string", summary: "Show which capabilities drive a management route." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Start here when driving ocx programmatically: it is the declared surface index, not a complete verb list."],
  },
  {
    command: ["provider", "list"],
    summary: "Configured providers with connectivity and selected models.",
    // Local config + PROVIDER_REGISTRY. Does not call GET /api/providers.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads local config; drives no management API route."],
  },
  {
    command: ["account", "list"],
    summary: "Codex OAuth accounts with pool priority and pause state.",
    routes: [{ method: "GET", path: "/api/codex-auth/accounts" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the account list as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "STATUS names `paused` alongside `selected`: a paused-but-selected account still receives requests.",
      "`--quota` shows cached Codex windows (including 5h); `--refresh` bypasses the server TTL.",
    ],
  },
  {
    command: ["usage"],
    summary: "Token and estimated-cost report over a time range.",
    routes: [{ method: "GET", path: "/api/usage" }],
    flags: [
      { name: "--range", value: "string", summary: "today | 1d | 7d | 30d | all" },
      { name: "--provider", value: "string", summary: "Restrict to one provider." },
      { name: "--model", value: "string", summary: "Restrict to one model id." },
      { name: "--json", value: "boolean", summary: "Emit the usage report as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "Per-account totals are withheld under `--provider` or `--model`: account rows cannot be honestly re-partitioned by provider, so the report says so rather than printing an empty table.",
      "An `(ambiguous)` account row aggregates several accounts; do not read it as one identity.",
    ],
  },
  {
    command: ["account", "pause"],
    summary: "Stop routing new requests to one account in the Codex pool.",
    // One route, both directions: `resume` is the same PUT with `paused: false`.
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the pause result as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "Pausing also unbinds threads pinned to the account and selects a fallback if it was active -- side effects of the route, not of the word `pause`.",
      "The issue that requested this reported the route as POST; it is PUT.",
    ],
  },
  {
    command: ["account", "resume"],
    summary: "Return a paused account to the Codex pool.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the resume result as JSON." }],
    mutates: true,
    json: "envelope",
  },
  {
    command: ["account", "pause-exhausted"],
    summary: "Pause every Codex account whose quota is spent.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit paused ids and the checked/failed counts as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "The route refreshes quota per account and can partially fail; a non-zero failed count exits 1 and sets ok:false, because silence would read as `none were exhausted`.",
    ],
  },
  {
    command: ["account", "strategy"],
    summary: "Show or set how an account pool picks the next account.",
    // Both pools, because both have the setting. The Codex pool reads its applied values
    // from the active payload; the Anthropic pool has its own GET.
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "A bare invocation reads and never writes.",
      "The APPLIED value is echoed, not the requested one, so a server-side normalization stays visible.",
      "Values are not re-validated in the CLI: the server owns the strategy names and the 1-100 sticky bound.",
      "`anthropic` is the only OAuth pool with this setting; other OAuth providers are refused without a round-trip.",
    ],
  },
  {
    command: ["account", "sticky"],
    summary: "Show or set how many consecutive requests stay on one account.",
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: ["Only meaningful under the sticky-capable strategies; the pool strategy is the other half of this setting."],
  },
  {
    command: ["logs"],
    summary: "Recent request log rows, filterable by provider, model, conversation, and status.",
    routes: [{ method: "GET", path: "/api/logs" }],
    flags: [
      { name: "--provider", value: "string", summary: "Restrict to one provider, matching failover attempts too." },
      { name: "--model", value: "string", summary: "Restrict to one model id, matching failover attempts too." },
      { name: "--conversation", value: "string", summary: "Restrict to one conversation id (`--conversationId` is accepted too)." },
      { name: "--status", value: "string", summary: "An exact code (429) or a class (5xx)." },
      { name: "--limit", value: "number", summary: "Row cap; defaults to 200." },
      { name: "--follow", value: "boolean", summary: "Stream new rows as JSONL; implies --jsonl." },
      { name: "--json", value: "boolean", summary: "Emit the server payload as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one row per line." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "`--provider` and `--model` both match a failover attempt, so a request is findable by what actually served it, not only by what was asked for.",
      "Rows print `conv=<id>` when the entry carries one, so a conversation filter can be told apart from an empty result.",
      "`--follow` deduplicates by row id and cannot be combined with `--json`.",
    ],
  },
];

/** Capabilities that drive `route`, for `ocx capabilities --route`. */
export function capabilitiesForRoute(path: string): Capability[] {
  return CAPABILITIES.filter(cap => cap.routes.some(r => r.path === path));
}

/** Every `(method, path)` pair any capability drives. */
export function capabilityRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const cap of CAPABILITIES) {
    for (const route of cap.routes) keys.add(`${route.method} ${route.path}`);
  }
  return keys;
}

/** Rendered command path, e.g. `ocx account pause`. */
export function capabilityInvocation(cap: Capability): string {
  return `ocx ${cap.command.join(" ")}`;
}
