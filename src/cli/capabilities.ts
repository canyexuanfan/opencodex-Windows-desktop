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
 * Capabilities that drive a management route.
 *
 * Deliberately incomplete at this phase: it covers the read/write surface the CLI
 * already reaches, and later phases add entries as they add verbs. The parity test
 * measures routes against capabilities plus declared exemptions, so a missing entry
 * shows up as an unexplained route rather than being quietly tolerated.
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
    summary: "Enumerate every CLI capability with the management routes it drives.",
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the full capability table as JSON." },
      { name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state." },
      { name: "--route", value: "string", summary: "Show which capabilities drive a management route." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Start here when driving ocx programmatically: it is the surface index."],
  },
  {
    command: ["provider", "list"],
    summary: "Configured providers with connectivity and selected models.",
    routes: [{ method: "GET", path: "/api/providers" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "payload",
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
      "Quota is only fetched under `--quota` (a deliberate cost decision), so 5h and weekly percentages appear in `account list --quota`, not bare `account list`.",
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
