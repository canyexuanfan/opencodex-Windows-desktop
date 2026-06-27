---
title: Installation
description: Install the opencodex (ocx) proxy, its prerequisites, and verify it runs.
---

opencodex ships as a single CLI, `ocx`. It runs as a small local HTTP server (built on Bun) and never
sends your traffic anywhere except the provider you configure.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` runs on the Bun runtime, but the runtime is bundled automatically on `npm install` — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client opencodex sits in front of. opencodex writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Install

```bash
npm install -g @bitkyc08/opencodex
```

Verify the binary is on your `PATH`:

```bash
ocx --help
```

## Run from source

To hack on opencodex itself:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev      # starts the proxy in dev mode (src/cli.ts start)
```

`bun run dev` starts the proxy API only (`/healthz`, `/v1/responses`, `/api/*`). It does not
serve the packaged dashboard at `/`.

The web dashboard lives in `gui/` and runs separately:

```bash
cd gui && bun install && bun dev
```

## What gets created

| Path | Purpose |
| --- | --- |
| `~/.opencodex/config.json` | Your providers, default provider, port, and options. |
| `~/.opencodex/ocx.pid` | PID of the running proxy (single-instance guard). |
| `~/.opencodex/auth.json` | Stored OAuth credentials (when you `ocx login`). |
| `~/.opencodex/catalog-backup.json` | Pristine Codex model catalog, backed up before any edit. |
| `$CODEX_HOME/config.toml` | opencodex appends a `[model_providers.opencodex]` table here on `ocx init` (defaults to `~/.codex/config.toml`). |

:::note
opencodex never deletes your Codex config. Every injection is reversible — `ocx stop`, `ocx restore`,
or `ocx eject` strip exactly the lines opencodex added and restore native Codex.
:::

## Next

Continue to the [Quickstart](/opencodex/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/opencodex/getting-started/how-it-works/) for the architecture.
