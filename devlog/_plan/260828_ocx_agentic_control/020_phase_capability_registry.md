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

To keep the declaration honest the test needs **three** checks, not two. Two are
obvious and insufficient:

1. **Scan -> registry.** Every `if (url.pathname === "…")` literal in the management
   files must exist in the registry. This has real reach — 188 such literals across
   those files — and it catches an added literal route.
2. **Registry -> source.** Every registry entry's path must appear in its declared
   owner file.

Check 2 **cannot hold for the 40+ non-literal routes** (lazy imports, path constants,
regex params, `endsWith`, prefix decode) named in 001. For those entries neither
direction verifies anything, so nothing detects an **under-declared** registry: a
route registered through `codex-restart-contract.ts:17` and simply omitted from the
registry is invisible to both, and `tests/cli-api-parity.test.ts` would then pass with
a genuine gap. The gate would be blind exactly where 001 says it must not be.

3. **Per-module route-count reconciliation.** For each handler module, assert
   `registryRoutesFor(module).length === literalCountIn(module) + nonLiteralAllowlist[module].length`,
   where `nonLiteralAllowlist` enumerates each non-literal route with the mechanism
   that registers it. Adding a non-literal route without registering it then fails on
   the count, and adding it to the allowlist without a registry entry fails too.

State all three in the test's header comment, with why none is sufficient alone, so a
future reader does not "simplify" it back to one mechanism. This is the unit's central
claim — if this gate can pass vacuously, nothing else in the unit holds.

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
usage path call `printSubcommandUsage("account")` etc. Where a usage string carries
genuinely local detail, move that detail into the capability's `details[]`.

**`ACCOUNT_USAGE` is not a dead export — it has four live consumers** at
account.ts:127, :213, :256, :317, each `console.error(ACCOUNT_USAGE)`. Replacing them
is a behavior change in two ways that must be handled deliberately:

| | current | `printSubcommandUsage` |
|---|---|---|
| stream | `console.error` (stderr) | `console.log` (stdout) |
| control flow | `return 1` | calls `process.exit(1)` on an unknown name |

Moving account usage errors from stderr to stdout breaks any script that separates
the streams, and swapping `return 1` for `process.exit` changes how the dispatcher
sees the result. Either give `printSubcommandUsage` an explicit stream/exit mode and
use the stderr+return variant here, or keep the four call sites returning 1 and only
source their **text** from the capability table. The second is smaller and preferred.
`tests/cli-account.test.ts:989` already drives `printSubcommandUsage("account")`, so
it will catch a careless swap.

Scope correction: 002 counts **37** usage blocks, of which 20 are the dead
module-level exports. This phase deletes the 20 dead ones and re-sources the
remainder's text; it does not delete the live ones.

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

## 020.5 — moved out

The uniform exit-code and `--json` contract work moved to its own work-phase,
`025_phase_uniform_cli_contract.md` (wp3b). This phase already carries banner
generation, ~20 constant deletions, a new command, a new server field, and three new
test files, and it is the phase every later phase blocks on. Adding two breaking
contract changes on top made it the largest phase in the stack by a wide margin.

Split rationale is dependency-shaped, not effort-shaped: the contract work *consumes*
the capability table this phase produces (it needs `json` declared per capability to
test order-independence), so it is a genuine successor phase rather than a slice
carved off to make this one smaller.

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
