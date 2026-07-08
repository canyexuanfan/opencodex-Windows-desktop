---
title: Quickstart
description: Configure your first provider and route OpenAI Codex through opencodex in three commands.
---

This guide takes you from a fresh install to running Codex against a non-OpenAI model.

## 1. Run the setup wizard

```bash
ocx init
```

`ocx init` walks you through:

1. **Pick a provider** — choose a preset (opencode zen, Anthropic, OpenAI, OpenRouter, Groq, Google,
   Azure) or `custom` to type a base URL and adapter.
2. **API key** — paste a key, or reference an environment variable like `${ANTHROPIC_API_KEY}`.
3. **Default model** — the model used when a request doesn't match another provider.
4. **Proxy port** — defaults to `10100`.
5. **Inject into Codex?** — when you accept, opencodex writes the `[model_providers.opencodex]` table
   into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and sets
   `model_provider = "opencodex"` so Codex routes through the proxy.

The result is saved to `~/.opencodex/config.json`.

:::note[GPT-5.6 preview]
On the preview channel, the wizard/catalog presets know about GPT-5.6 Sol/Terra/Luna. Use ChatGPT
passthrough, OpenAI (API key), or OpenRouter only when that upstream account already has access; the
synced Codex entries include `max` reasoning and 372,000 usable-token context metadata.
:::

## 2. Start the proxy

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

On start, opencodex:

- writes its PID to `~/.opencodex/ocx.pid` (and refuses to start twice),
- fetches each provider's live model list and **syncs them into Codex's model catalog**, and
- listens on `http://localhost:<port>/v1`.

Check it:

```bash
ocx status
```

## 3. Use Codex

Codex now talks to opencodex transparently:

```bash
codex "Refactor this function for readability"
```

To target a specific routed model, use the `provider/model` form Codex's model picker shows:

```bash
codex -m "anthropic/claude-opus-4-8" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Logging in instead of pasting a key

Some providers support real account login (OAuth, auto-refreshed):

```bash
ocx login xai          # or: anthropic, kimi
ocx logout xai
```

OpenAI itself needs **no key** — the default provider forwards your existing `codex login`
credentials straight through (see [Providers](/opencodex/guides/providers/)).

## Stopping & restoring

```bash
ocx stop      # stop the proxy and restore native Codex
ocx restore   # restore native Codex without stopping (alias: ocx eject)
```

## Next

- [How It Works](/opencodex/getting-started/how-it-works/) — what happens to each request.
- [Providers](/opencodex/guides/providers/) — every way to authenticate.
- [Configuration](/opencodex/reference/configuration/) — the full `config.json` reference.
