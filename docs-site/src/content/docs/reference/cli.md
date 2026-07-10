---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for top-level usage.
Run `ocx help <command>` for commands registered in the help table. Help and version commands are
read-only and do not start, stop, install, uninstall, or rewrite Codex/opencodex state.

## Setup & lifecycle

### `ocx init`

Interactive setup wizard. Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
default model, and proxy port; saves `~/.opencodex/config.json`; optionally injects the proxy into
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); and optionally installs the Codex
autostart shim.

### `ocx start [--port <port>]`

Start the proxy server (preferred port `10100`). If that port is occupied, opencodex selects and
records another available port. It writes PID/runtime-port state and refuses to start a second live
instance. On start it syncs each provider's models into Codex's catalog. On shutdown it restores
native Codex — unless it was launched as a managed service (`OCX_SERVICE=1`).

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Stop the running proxy (by PID), remove the PID file, and restore native Codex. If a managed
background service is installed, `ocx stop` also stops it first (so it won't respawn the proxy).
The same action is available from the web dashboard's **Stop** button (`POST /api/stop`).

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

Pass `back` to either spelling to re-point plain `codex` at an already-running proxy without changing
the proxy lifecycle:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

Explicit recovery for older development builds that remapped Codex App history before reversible
backup support existed. Close Codex first if its history database is locked.

### `ocx restart`

Run `stop` followed by `ensure`: stop the proxy/service, restore native Codex, start the proxy in the
background, and sync the live port back into Codex.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `ocx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL,
config path, default provider, Codex autostart setting, service state, and shim state.

Use `--json` for a machine-readable, read-only diagnostics contract:

```bash
ocx status --json
```

Abbreviated example shape:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

The real object also includes `listen` (port, hostname, runtime/config source), config load
diagnostics, and bundled Codex plugin diagnostics. The JSON schema is additive-only: future versions
may add fields, but existing fields should stay stable. It intentionally excludes API keys, OAuth
tokens, authorization headers, request content, emails, and account identities.

### `ocx health [--json]`

Identity-check the live proxy. Human output reports PID/port; `--json` emits `{ok, pid, port}`. The
command exits 0 only when healthy and 1 otherwise, making it suitable for service probes.

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.

## Models & Codex

### `ocx sync`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

### `ocx sync-cache`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog.

### `ocx v2 [subcommand]`

Manage the Codex `multi_agent_v2` feature flag and the 3-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature in `$CODEX_HOME/config.toml` and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync. |
| `mode v1` | Force ALL models to the v1 multi-agent surface (overrides upstream pins). |
| `mode default` | Respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag). Install default. |
| `mode v2` | Force ALL models to the v2 multi-agent surface (overrides upstream pins). |
| `threads <n>` | Set `max_concurrent_threads_per_session` (integer >= 1, v2 only). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
The `on`/`off` subcommands flip the codex-rs feature flag via `codex features enable|disable`.
Changes apply to new Codex sessions; running sessions keep their pinned surface.

### `ocx models [--provider <name>] [--json]`

List the models statically seeded in configured providers. `--provider` filters one configured
provider and `--json` returns model metadata plus a reminder that `liveModels` may add runtime-only
entries. This command does not fetch live catalogs; use `ocx sync` or the dashboard for that.

### `ocx provider <subcommand>`

Non-interactive provider management. Registry entries are seeded by name; a custom name requires
both `--adapter` and `--base-url`.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | List configured providers and the remaining registry entries. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Add a registry/custom provider. `--force` overwrites; `--sync` refreshes a running proxy in human-output mode. |
| `show <name>` | `--json` | Show config with API keys masked. |
| `remove <name>` | `--json` | Remove a non-default provider; the last provider cannot be removed. |
| `set-default <name>` | `--json` | Select an existing provider as the default. |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

## Authentication

### `ocx login <provider>`

Start the provider's registered login flow. OAuth providers open a browser and store auto-refreshed
credentials under `~/.opencodex/`; API-key login providers open their key dashboard, prompt for the
key, validate it when possible, and save the resulting provider config. The command prints the
currently accepted OAuth and API-key provider ids when the name is missing or unknown.

```bash
ocx login xai
```

### `ocx logout <provider>`

Remove the stored OAuth credential for a provider.

## Dashboard

### `ocx gui`

Open the [web dashboard](/opencodex/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting
the proxy if it isn't running.

## Background service

### `ocx service [subcommand]`

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart doesn't churn the Codex config.

| Subcommand | Action |
| --- | --- |
| none | Create/update and start the service. |
| `install` | Create and start the service. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report whether the service is running. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

If Codex is updated and overwrites the wrapper, the shim auto-repairs on the next `install` call —
the new binary is backed up and a fresh wrapper is written.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove the shim and restore the original Codex binary. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state (installed / stale / missing). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `ocx service` for an always-on background proxy (recommended). Use `ocx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

## Diagnostics

### `ocx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, Codex plugin and project-config warnings,
and pending history migration. It prints repair hints but does not apply them.

### `ocx debug [provider|usage …]`

Read or change runtime debug overrides through the running proxy's management API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

With no scope, `ocx debug` prints usage and, when the proxy is stopped, the next-start environment
defaults. Provider debug defaults from `OCX_DEBUG=1` (legacy `OCX_DEBUG_FRAMES=1` also works); usage
debug defaults from `OPENCODEX_USAGE_DEBUG=1`.

## Updating

### `ocx update`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you're already on the newest version for that
tag. A running proxy is stopped before files are replaced; an installed service is rebuilt and
started automatically, while a foreground installation prints `ocx start` as the next step.

```bash
ocx update
ocx update --tag preview
```

New versions become available the moment the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Help

`ocx help`, `ocx --help`, `ocx -h` — print top-level usage and examples.

`ocx help <command>`, `ocx <command> --help`, `ocx <command> -h` — print command-specific usage for
commands registered in `src/cli/help.ts`. The full `provider`, `debug`, and `v2` subcommand contracts
are documented above.

Unknown commands remain errors even when a help flag is present, so scripts can rely on the exit
code instead of scraping text.

## Version

`ocx --version`, `ocx -v`, `ocx version` — print a single script-friendly version line and exit.

## Internal commands

Two dispatch targets are intentionally omitted from normal help: `__refresh-version [preview]`
refreshes the update-notification cache in a detached process, and
`__gui-update-worker <job-id> [latest|preview] [restart]` runs a dashboard update job. They are
implementation details, not stable user-facing commands.
