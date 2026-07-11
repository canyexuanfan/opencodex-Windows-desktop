---
title: Claude Code
description: Use any routed model from Claude Code — opencodex serves the Anthropic Messages API and gateway model discovery on the same port.
---

opencodex serves `POST /v1/messages` (plus `count_tokens`) alongside `/v1/responses`, so Claude
Code can use every routed provider — OAuth logins, account pools, key failover and sidecars
included — with zero extra auth work.

## Quickstart

```bash
ocx claude
```

`ocx claude` ensures the proxy is running, then launches Claude Code with the environment wired:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Only when the proxy requires an API key — otherwise it is NOT set, so your claude.ai login (subscription + connectors) stays active |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (native `/model` picker discovery) |
| `ANTHROPIC_MODEL` | `claudeCode.model` (optional) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.smallFastModel` (optional, legacy `ANTHROPIC_SMALL_FAST_MODEL` too) |

Variables you export yourself always win. Extra arguments pass through: `ocx claude -p "hello"`.

## Native Claude passthrough (subscription pierce)

With no auth override set, Claude Code keeps its claude.ai OAuth login and sends it to the proxy.
Requests for genuine `claude*`/`anthropic*` models that no alias or model map claims are forwarded
**verbatim** to `api.anthropic.com` with your own credential and all end-to-end headers — betas,
thinking signatures, prompt caching and billing identity stay fully native, and routed models keep
working in the same session via the picker aliases. This also means the
"claude.ai connectors are disabled" warning no longer appears with `ocx claude`.
Disable with `claudeCode.nativePassthrough: false`; point elsewhere with `claudeCode.anthropicBaseUrl`.

## The /model picker ("From gateway")

Claude Code 2.1.129+ can discover gateway models: it calls `GET /v1/models?limit=1000` and lists
entries in the native `/model` picker, labeled "From gateway". Because the picker only accepts ids
beginning with `claude` or `anthropic`, opencodex exposes routed models as stable, reversible
aliases:

```
claude-ocx-<provider>--<model>     e.g. claude-ocx-gemini--gemini-3-pro
claude-ocx-native--<slug>          e.g. claude-ocx-native--gpt-5.5   (native OpenAI models)
```

Each entry carries an honest display name such as `gemini-3-pro (gemini)`. Selecting one persists
it to Claude Code's `settings.json` `model` field; inbound requests resolve the alias back to the
routed model. On older Claude Code versions the picker stays native — set slots via
`ANTHROPIC_MODEL` or type any routed id with `/model` (Claude Code passes strings through).

## GUI

The dashboard has a dedicated **Claude** page (below API in the sidebar): the inbound kill switch,
quickstart and manual env block, default/small-fast slot pickers, a model map editor, and a preview
of the aliases the picker will discover. The sidebar also carries a **Claude ON** toggle (the label
is intentionally the same in every language) that flips the inbound on and off.

## Model map

`claudeCode.modelMap` rewrites inbound Anthropic model ids to routed models before routing:

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

Lookup order: discovery alias, exact id, id with the date suffix stripped (`-20250514`), passthrough.

## Manual setup (without ocx)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

Or persist it in `~/.claude/settings.json` under the `env` key. Leave `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` unset unless the proxy requires an admission key — any auth override disables
claude.ai connectors and replaces your subscription login.

## Notes and limits

- **Streaming first.** The inbound always streams internally; non-streaming clients get the folded
  message JSON.
- **Thinking.** Reasoning streams to Claude Code as `thinking` blocks (with a synthetic signature);
  thinking blocks replayed by Claude Code are dropped before routing — providers carry reasoning in
  their own envelopes.
- **count_tokens is an estimate.** Claude Code's context meter uses a character-based
  approximation; the endpoint is optional in the gateway protocol.
- **Kill switch.** `claudeCode.enabled: false` (GUI: Claude ON toggle) answers `/v1/messages` with
  403 and empties the discovery list.
- Requests appear in the Logs/Usage pages like any other routed traffic.
