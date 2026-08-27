# 020 — wp3: capability registry as the single source of truth (#2701)

Closes: #2701. Branch: `codex/ocx-capability-registry` off
`codex/ocx-transport-honesty`.

This is the keystone. Everything after it registers into the structure this phase
introduces; building verbs first means writing them twice.

## The problem in one line

The CLI's help is 20 module `USAGE` constants with zero consumers outside their own
files, plus a hand-written banner explicitly exempted from matching the registry,
and **nothing anywhere relates the CLI surface to the 183 management routes.**

## Design: one capability table, three consumers

NEW `src/cli/capabilities.ts` — a declarative table describing, per CLI capability:
the command path, the management route(s) it drives, its flags, whether it mutates,
and its `--json` shape. Three consumers read it:

1. `help.ts` generates the banner and every subcommand usage block from it.
2. `tests/cli-api-parity.test.ts` asserts every route in the API registry has a
   capability or a recorded exemption.
3. The new `ocx capabilities` verb emits it as JSON — the machine-readable index an
   agent reads first to discover what it can do.

The third consumer is the point of the whole unit: an agent should not have to parse
help text.

### Shape

```ts
export type CapabilityRoute = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;          // "/api/codex-auth/accounts/pause"
};

export type CapabilityFlag = {
  readonly name: string;          // "--id"
  readonly value?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly summary: string;
};

export type Capability = {
  readonly command: readonly string[];      // ["account", "pause"]
  readonly summary: string;
  readonly routes: readonly CapabilityRoute[];
  readonly flags: readonly CapabilityFlag[];
  readonly mutates: boolean;
  readonly json: "payload" | "envelope" | "none";
  readonly details?: readonly string[];
};
```

### Route registry (server side)

NEW `src/server/management/route-registry.ts` — a declared list of every reachable
management route with method, path pattern, auth class, and a mutation flag.

This must be **declared, not harvested.** 001 established that 40+ routes are
invisible to a string grep: lazy `import()`, handlers outside the `??` chain, path
constants, prefix decoding, regex params, `endsWith` matching. A parity test built on
`rg` would pass vacuously while missing the entire `/api/codex-auth/*` family.

To keep the declaration honest, add a second test that the registry does not drift
from the handlers: for every registry entry, assert the owning handler module exports
a marker or that the literal appears in the declared owner file, and for every
`if (url.pathname === "…")` literal found by scan, assert it exists in the registry.
The scan catches added literals; the declaration covers the non-literal routes the
scan cannot see. Neither alone is sufficient; state that in the test's header comment
so a future reader does not "simplify" it back to one mechanism.

### Exemptions

NEW in the registry: an `exempt` field with a required reason, one of:

| Reason | Routes | Justification |
|---|---|---|
| `session-only` | `POST /api/github/star`, 6 `/api/codex-prompt*` writes | dashboard session required; the star POST is the user-consent boundary in `AGENTS_INSTALL.md` and must never get a verb |
| `disabled` | `PUT /api/config` | deliberate 405 |
| `capability-principal` | `POST /api/providers/reload` | process-scoped HMAC principal, not an operator action |
| `test-seam` | `/api/storage/*/test-stream` (2) | test seams, not operator capability |
| `local-transport` | 20 `/api/lab/*` reads | `ocx lab` reaches the same data via local SQLite |
| `dead` | shadowed `GET /api/storage` in logs-usage-routes | unreachable; delete instead |

An exemption without a reason string fails the test. That is what stops the gate
from being silently widened later.

## 020.1 — generate the banner

MODIFY `src/cli/help.ts`. Replace the 69-line hand-written template (lines 18-88)
with a renderer over `CAPABILITIES` grouped by section. Keep the existing top/bottom
prose. `printSubcommandUsage` (line ~94) switches from `CLI_COMMANDS` to the
capability table, falling back to the registry entry for commands that have no
management route (`init`, `start`, `service`, …).

MODIFY `tests/cli-registry.test.ts`: the current test greps `help.ts` source for
command names, and its comment at line 104 licenses drift ("curated… not required to
match the registry exactly"). Replace with an assertion that the rendered banner
contains exactly the visible capability set — generation makes the license obsolete.

## 020.2 — retire the 20 dead `USAGE` exports

For each module listed in 002, delete the module-level `USAGE` constant and have the
usage path call `printSubcommandUsage(["account"])` etc. Where a usage string
carries genuinely local detail, move that detail into the capability's `details[]`.

`ocx ready`'s triplicated string (registry.ts:354, root.ts:74, ready.ts) collapses to
one capability entry.

This is mechanical but large. It is in this phase rather than deferred because the
generated banner and the hand-written blocks would otherwise contradict each other,
which is the exact failure #2701's reporter hit.

## 020.3 — `ocx capabilities`

NEW `src/cli/capabilities-command.ts`:

```
ocx capabilities                 human tree
ocx capabilities --json          full machine-readable table
ocx capabilities --json --mutating-only
ocx capabilities --route /api/keys   which commands drive this route
```

Register in `dispatch.ts` and `registry.ts`. This is the agent's entry point.

## 020.4 — version skew (#2701)

MODIFY `src/server/proxy-liveness.ts`: add `version?: string` to `LiveProxy` and
populate it in the probe that already parsed and validated the healthz body
(`isOpencodexHealthz`, line ~94). No extra request, so the race the comment at
status.ts:192 avoids is not reintroduced.

MODIFY `src/cli/status.ts` `collectStatus`: compare `live.version` against
`packageVersion()` (export it from `help.ts`) and, when they differ, push

```
warning: CLI 2.35.0 does not match the running proxy 2.36.1 — this ocx on PATH is
stale. Its help and features describe a different build. Reinstall or run the
proxy's own binary.
```

Add `cliVersion` and `proxyVersion` to `CliStatusJson`. Mirror the warning in
`runDoctor`.

## 020.5 — the exit-code contract

Now that help is generated, make the contract uniform and documented in one place:

- `doctor` and `sync-cache` return non-zero on failure (002 flagged both as always 0).
- `--json` becomes order-independent everywhere via `takeFlag`: fixes `status`
  (lone-arg only) and `restore` (positional `args[1]`, so `ocx restore back --json`
  currently ignores the flag).
- `doctor`, `login`, `logout`, `sync`, `sync-cache`, `debug` gain `--json`.
- The capability table declares each command's `json` mode, and a test asserts every
  capability with `json !== "none"` actually accepts the flag anywhere in argv.

`doctor` changing from always-0 is a **breaking change for pipelines**. Call it out
in the PR description and the docs-site changelog entry; the alternative is a
diagnostic command that cannot gate anything, which is worse.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-api-parity.test.ts` (NEW) | every registry route has a capability or a reasoned exemption; every capability route exists in the registry |
| `tests/management-route-registry.test.ts` (NEW) | registry vs handler-source drift, both directions |
| `tests/cli-registry.test.ts` | generated banner equals the visible capability set |
| `tests/cli-capabilities.test.ts` (NEW) | `--json` shape is stable; `--route` filter resolves |
| `tests/cli-status-json.test.ts` | `cliVersion`/`proxyVersion` present; mismatch warns |
| `tests/doctor.test.ts` | drift warning; non-zero exit on failure |

## Accept criteria

1. `ocx --help` is generated; no hand-maintained command list remains.
2. A new route with no verb and no exemption fails `tests/cli-api-parity.test.ts`.
3. `ocx capabilities --json` enumerates the surface with routes and flags.
4. `ocx status` warns on version skew and reports both versions in JSON.
5. Every capability declaring JSON accepts `--json` in any argv position.

