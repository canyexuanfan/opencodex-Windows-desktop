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

## System Environment Integration

On macOS, `ocx start` automatically sets `ANTHROPIC_BASE_URL` and the related Claude Code
environment variables system-wide with `launchctl setenv`. New terminal windows and tabs therefore
route plain `claude` commands through the proxy without requiring the `ocx claude` wrapper.
Already-open shells are unaffected and must be reopened to pick up the change.

`ocx stop` and proxy shutdown restore the previous environment. Disable this integration with
`claudeCode.systemEnv: false` in the configuration or with the GUI toggle. This feature is macOS-only;
on other platforms, use `ocx claude` to launch Claude Code with the proxy environment.

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
aliases — a different family per surface:

```
claude-ocx-<provider>--<model>     Claude Code CLI (readable, e.g. claude-ocx-native--gpt-5.6-sol)
claude-opus-4-8-<code>             Claude Desktop 3P (hashed, e.g. claude-opus-4-8-ncb)
```

The proxy picks the family per request: `?ids=cli|desktop` wins, otherwise the Claude Code
discovery user-agent (`claude-code/<version>`) gets the readable form and every other client keeps
the hashed Desktop family. Both families (plus bare routed ids via `--model gpt-5.6-sol`) decode
forever, so a model saved in `settings.json` under either form keeps working — after this change an
old hashed selection just shows as a custom entry until you re-pick it from the refreshed list.
Routes the readable form cannot express (provider names containing `--` or `/`) fall back to the
hashed alias so no model disappears.

Each entry carries an honest display name such as `gemini-3-pro (gemini)`, plus full model
capabilities (reasoning-effort ladder, thinking types) in the official ModelInfo shape so Claude
Desktop's third-party gateway mode can offer its effort selector. Real Anthropic models keep their
canonical ids on both surfaces.
Models with an authoritative 1M context window get an extra `…[1m]` picker row: selecting it makes
Claude Code account a full 1M context for that model (auto-compaction stays on) — the proxy strips
the marker before routing.

### Auto context (big-context models without the 200k ceiling)

Claude Code accounts 200k tokens for any model it does not recognize — even when the routed model
really holds 372k or 400k. **Auto context** (on by default) fixes that with two moves:

1. Models whose real window is above 200k **and** at least the auto-summarize point get the
   `[1m]` marker on their picker rows and env slots (Claude Code then accounts 1M for them).
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (default `350000`) is injected so the conversation is
   auto-summarized at that point. Claude Code applies `min(accounted window, this value)`, so the
   one env value acts like a per-model floor: marked models compact at 350k, unmarked 200k models
   keep their normal behavior.

The value is adjustable on the Claude page (accepted range 100000–1000000). **Warning:** raising
it past a model's real window breaks that model — the chat errors out before the summary can fire.
Sub-1M native Anthropic models are never auto-marked, and values you export yourself always win
(the proxy then uses YOUR value to decide which models are safe to mark). Setting the legacy
`maxContextTokens` override disables auto context entirely.
Selecting one persists it to Claude Code's `settings.json` `model` field; inbound requests resolve
the alias back to the routed model. On older Claude Code versions the picker stays native — set
slots via
`ANTHROPIC_MODEL` or type any routed id with `/model` (Claude Code passes strings through).

## Subagent tier models

Claude Code subagents choose models by tier alias (`opus` / `sonnet` / `haiku` / `fable`). The
roster agents above (`ocx-*`) are the preferred way to dispatch specific routed models, so the
tier mapping is CONFIG-ONLY now (`claudeCode.tierModels` — no GUI control); when set, `ocx claude`
(and the system-wide env option) injects `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` (fed by the small/fast slot unless overridden) and
`ANTHROPIC_DEFAULT_FABLE_MODEL`. 1M-context targets are marked `[1m]` automatically. Values you
export yourself always win.

## GUI

The dashboard has a dedicated **Claude** page (below API in the sidebar): the inbound kill switch,
quickstart and manual env block, the background-helper model picker, the model interception
(modelMap) editor, and a preview
of the aliases the picker will discover. The sidebar also carries a **Claude ON** toggle (the label
is intentionally the same in every language) that flips the inbound on and off.
The default main model is owned by Claude Code's own `/model` picker (persisted to its
`settings.json`), so the page no longer duplicates it.

## Roster agents (injectAgents)

`ocx claude` (and the system-env daemon) syncs your featured subagent roster (Subagents tab,
up to 5 models) plus `ocx-self` — pinned to your `/model` picker default (falling back to
`claudeCode.model`; omitted when neither exists) — into `~/.claude/agents/ocx-*.md`. Dispatch
any routed model with `subagent_type: "ocx-gpt-5-6-sol"`. Because Claude Code ignores custom
gateway ids in agent frontmatter, each body carries an `<!-- ocx-route: ... -->` directive the
proxy uses to pin the real route — the Agent tool's `model` argument is therefore inert for
these agents (pass `"sonnet"` as a placeholder or omit it). 1M-capable targets carry `[1m]`
automatically. Only
marker-verified `ocx-*.md` files are ever overwritten or pruned; your own agents are never
touched. Turn it off with `claudeCode.injectAgents: false` (owned files are pruned).

## Bundled-skill elision (blockedSkills)

Claude Code's bundled `claude-api` skill injects an ~840KB Anthropic documentation bundle
(~136k tokens) into the conversation the moment it loads — and it auto-triggers on casual
mentions of Claude models (see anthropics/claude-code#74473, #63566, #69164). Third-party
routed models are not trained on that bundle, so by default opencodex replaces the skill's
tool-result body with a short stub on ROUTED requests. Native Anthropic passthrough is
untouched — Claude models keep the full content. Configure with `claudeCode.blockedSkills`
(default `["claude-api"]`; `[]` turns the elision off; add more skill names to widen it).
The stub keeps the tool call/result pairing intact, so nothing breaks on replay.

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

## Reasoning effort

Claude Code's `/effort` setting is preserved across the adapter. The adaptive wire format
(`thinking: { type: "adaptive" }` plus `output_config: { effort }`) passes its effort through
directly. Legacy `thinking.enabled` requests map `budget_tokens` to `low` at 4096 or below,
`medium` at 16384 or below, and `high` above that. When thinking is disabled, as it commonly is
for subagents, THE PROXY omits reasoning parameters for that request (deliberate: routed
providers must not receive reasoning knobs the client turned off). The resolved value appears in the request log's
**Reasoning effort** column.

## Prompt caching

- On Anthropic-routed requests, the adapter manages cache breakpoints for tools, system content,
  and the penultimate user message, plus top-level automatic `cache_control`. Stable turns normally
  produce about a 99.9% cache hit rate.
- Native OpenAI/ChatGPT routing derives a session-scoped `prompt_cache_key` and `session_id` header
  to keep cache affinity.
- `CLAUDE.md` is injected only into the first user message, so it does not invalidate the prompt
  cache on every turn.

## Token usage in Logs and Usage

The request log total is input (including cached input) plus output. A `c` suffix marks cache reads
(hits), while `w` marks cache writes (creation). The Usage page also reports cache hits and cache
creation separately.

## Manual setup (without ocx)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

Or persist it in `~/.claude/settings.json` under the `env` key. Leave `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` unset unless the proxy requires an admission key — any auth override disables
claude.ai connectors and replaces your subscription login.

## Production notes

- **Streaming first.** The inbound always streams internally; non-streaming clients get the folded
  message JSON.
- **Thinking.** Reasoning streams to Claude Code as `thinking` blocks (with a synthetic signature);
  thinking blocks replayed by Claude Code are dropped before routing — providers carry reasoning in
  their own envelopes.
- **Errors.** Upstream failures are mapped to Anthropic's error taxonomy: 400, 401, 403 and 404;
  `rate_limit_error` for 429; `overloaded_error` for 529; and `api_error` for other 5xx responses.
  `Retry-After` is preserved.
- **count_tokens follows routing.** Routed models use an approximation. Native Anthropic models
  with an `sk-ant` credential pass the request through to the real Anthropic API.
- **SSE streaming.** Streaming responses use server-sent events and include `ping` events.
- **Kill switch.** `claudeCode.enabled: false` (GUI: Claude ON toggle) answers `/v1/messages` with
  403 and empties the discovery list.
- Requests appear in the Logs/Usage pages like any other routed traffic.
