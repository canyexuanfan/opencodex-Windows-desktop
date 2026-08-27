# 002 — CLI surface and help inventory

Source: read of `src/cli/*`, `bin/ocx.mjs`, `package.json`, `tests/cli-*.test.ts`.

## Dispatch chain

```
bin/ocx.mjs  (Node shim, execs the bundled Bun binary)
  -> src/cli/index.ts:99   runCli(argv.slice(2))
       -> src/cli/root.ts:25   parseCliHead()          pure, no I/O
            version/help -> exit 0
            ready        -> pre-parsed, exit 64 before any I/O
            command      -> maybeAutoRestoreCodexShim, return head
  -> src/cli/index.ts:956  process.exit(await dispatchCommand(head, deps))
       -> src/cli/dispatch.ts:584  commandRunners[resolveDispatchCommand(cmd)]
```

57 runner keys (`DISPATCH_COMMANDS.size`); the registry declares 58 entries
(`CLI_COMMANDS.length`), 52 of them visible. Counted by importing the modules, not
by regex — an earlier regex count of 52/49/43 was wrong in all three figures and
would have sized wp3's banner test against the wrong set. Aliases resolve
through registry pairs (dispatch.ts:568): `setup->init`, `eject->restore`,
`remove->uninstall`, `model->models`.

Exit codes converge on the single `process.exit` at index.ts:956. A runner that
returns `Number(process.exitCode ?? 0)` preserves inner failures; a runner with a
hardcoded `return 0` discards them. That asymmetry is #2697.

## Exit-code vocabulary

From `src/cli/runtime-api.ts:311`: **0** ok, **2** `CliUsageError`, **4** HTTP 404,
**5** HTTP 409, **1** everything else. Only `ready` uses **64**.

A 503 and a generic failure are both **1**, so a script cannot distinguish
"management plane fenced" from "your argument was wrong" by exit code alone.

## Two management clients, two contracts

**Client 1 — `src/cli/runtime-api.ts:61`.** Used by observe, combo, alias, access,
agent, system, route-policy, export, integrations, v2.

- Base URL: `deps.baseUrl` override, else `findLiveProxy()` (identity-checked,
  finds fallback ports), then `http://{probeHostname(live.hostname)}:{live.port}`.
- Auth: `X-OpenCodex-API-Key` from `src/lib/admin-secrets.ts:23` —
  `OPENCODEX_ADMIN_AUTH_TOKEN` env, else `$configDir/admin-api-token`, validated
  `/^ocx_admin_[A-Za-z0-9_-]{43}$/`, rejecting symlinks and files over 512 B.
- Proxy down -> `RuntimeApiError(503)`; fetch throw -> 503 "unreachable". Both land
  on exit 1.
- Non-2xx -> throw with `status` **and the full `body` retained** (line 86).

**Client 2 — `src/cli/account-api.ts:88` `apiJson`.** Used by the whole `account`
family. Same base-URL and header resolution, but it **never throws**: it returns
`{status, json}` and collapses every network error to sentinel `status: 0` inside a
catch block with an empty body (line 106), discarding the underlying message. Failures funnel
through `apiError` -> exit 1 always; no 404->4 / 409->5 mapping.

## Error bodies are dropped: `reason` and `hint`

`responseMessage` (runtime-api.ts:50) scans only `error`, `message`, `detail`.
`apiError` (account-api.ts:123) reads only `json.error`. Management routes emit
`reason` as the actionable field in roughly 39 places — integration-routes,
native-integration-routes (`home_mismatch`, `apply_incomplete`,
`metadata_unreadable`, `not_durable`), agent-settings-routes
(`desired_state_changed`). A body of `{ok:false, reason:"home_mismatch"}` with no
`error` key prints the generic `Management request failed (409)`.

The body is already attached to the thrown error, so this is a rendering fix, not a
plumbing one. One narrow exception is already special-cased: `cleanupRequired` at
account-api.ts:126.

## HELP-SOT: there is none

Three disconnected tiers:

1. **Registry** — `src/cli/registry.ts:10` `CLI_COMMANDS`, 58 entries with
   `usage`/`summary`/`details`. Consumed only by `printSubcommandUsage`
   (help.ts:94) and alias resolution.
2. **Hand-written banner** — `src/cli/help.ts:18-88`, one 69-line template
   literal, maintained by hand, **not generated from the registry**.
3. **37 module-level `USAGE`/usage-string blocks** by `rg` count, of which the
   20 below are the named module-level constants. The 20 listed here are the
   *dead exports*; the remaining ~17 are inline or locally-consumed usage strings
   that also need a home in the capability table. Each is its own authority:

account-auth.ts:33 · access.ts:12 · export-command.ts:53 · account.ts:18 ·
account-extended.ts:38 · account-main.ts:15 · provider.ts:424 + :130 ·
provider-runtime.ts:22 · models.ts:19-21 (three) · models-runtime.ts:16 ·
agent.ts:23 · observe.ts:16 · combo.ts:13 · route-policy.ts:12 · alias.ts:3 ·
system-command.ts:14 · config-command.ts:9 · lab.ts:76 · integrations.ts:15,24,30,227 ·
claude-desktop.ts:25 (inline `console.log`) · debug.ts:184 (string interpolation).

Plus one-off inline strings at index.ts:106, :835, :917; root.ts:74;
dispatch.ts:344, :443, :506.

`ocx ready`'s usage string is duplicated verbatim in **three** places —
registry.ts:354, root.ts:74, ready.ts — with no test tying them together.

**What is enforced today:** `tests/cli-registry.test.ts:107` greps `help.ts` source
to assert every visible canonical command appears in the banner, and
`tests/cli-dispatch.test.ts:12` asserts registry-to-dispatch coverage both ways.
The banner is explicitly documented at test:104 as "curated… not required to match
the registry exactly."

**Nothing validates the module `USAGE` blocks.** The exported constants
(`OBSERVE_USAGE`, `COMBO_USAGE`, `LAB_USAGE`, `AGENT_USAGE`, `SYSTEM_USAGE`,
`CONFIG_USAGE`, `ACCESS_USAGE`, `EXPORT_USAGE`, …) have zero consumers outside
their own files, including in tests. They are dead exports, free to drift. That is
the mechanism behind #2701's "help lies" symptom — a stale binary is one cause, an
unvalidated help string is the other.

## `--json` is not a uniform contract

- Registry declares `--json` for `tray`, but `windowsTrayCommand` always returns 0.
- `status` accepts `--json` only as a **lone** argument (index.ts:833), unlike the
  order-independent `takeFlag` parsing used everywhere else.
- `restore --json` is matched positionally at `args[1]`, so `ocx restore back --json`
  silently ignores the flag.
- `doctor`, `login`, `logout`, `sync`, `sync-cache`, `debug` have no `--json` at all.
- `doctor` and `sync-cache` always exit 0, so neither can gate a script.

## Commands with no HTTP reach at all

- `ocx config` — direct file I/O; never calls `/api/config` (config-command.ts).
- `ocx lab` — reads the local SQLite projection directly; never calls `/api/lab/*`.

Both are capability-present/endpoint-absent. They are not parity gaps by
capability, but they do mean a remote or containerized agent cannot reach them.
Recorded as an explicit exemption class rather than folded into the parity count.
