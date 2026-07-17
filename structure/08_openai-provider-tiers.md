# OpenAI Provider Tiers SOT

OpenAI routing has exactly three public provider ids. They are separate authority boundaries, not
aliases and not fallback stages.

| Provider id | Product tier | Credential owner | Account selection |
| --- | --- | --- | --- |
| `openai` | Codex Direct | bearer/session headers on the current Codex request | main login only; never reads or rotates the pool |
| `openai-multi` | Codex Multi-account | hardened Codex account store | main login plus every added account; affinity, quota, cooldown, and health choose an eligible account |
| `openai-apikey` | OpenAI API | configured API key or active key-pool entry | no Codex-account lookup or fallback |

Bare native model ids use Direct. Multi and API selection is explicit:

```text
gpt-5.6-sol                         # Direct
openai-multi/gpt-5.6-sol            # Multi-account pool
openai-apikey/gpt-5.6-sol           # OpenAI API key
openai-apikey/gpt-5.6-sol-pro       # API Pro virtual model
```

The main Codex login is an ordinary eligible member of Multi. Direct never enters pool selection,
and no tier falls through to another tier because a credential is absent or unhealthy.

## Migration and restore

Startup projects unmarked legacy `openai`/`chatgpt` forward configs into canonical Direct and Multi
providers, preserving provider order and unrelated config. A legacy install with pool accounts moves
its default to `openai-multi`; otherwise it remains `openai`. The public legacy `chatgpt` provider id
is hidden after migration. The marker `openaiProviderTierVersion: 1` makes later starts idempotent.

Before the first migration, opencodex creates a mode-0600, no-replace backup:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v1.bak ~/.opencodex/config.json
```

Restoring that file intentionally restores the legacy config; the next opencodex start projects it
again without replacing the original backup.

## Model and wire identity

- Direct and Multi expose bare native ids from the pinned/live Codex catalog. Their GPT-5.6 catalog
  window remains the Codex-native 372,000-token contract.
- `openai-apikey` exposes namespaced API rows. GPT-5.6 Sol/Terra/Luna and their Pro variants use
  1,050,000 context tokens and 922,000 max input tokens.
- Its trusted catalog contains exactly eight ids: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and the
  three corresponding Pro variants. No generic `gpt-5.6-pro` alias exists.
- `*-pro` ids are virtual selected identities. The upstream request uses the base id and
  `reasoning.mode: "pro"`; request logs, usage, management APIs, disabled-model state, subagent state,
  and injection state preserve the selected virtual id.
- Compact requests preserve the selected tier but send the base model without a reasoning object.
- HTTP/SSE, Responses WebSocket, compact, and sidecar candidate selection share the same tier
  ownership. Forward sidecars consider Direct before Multi and never use `openai-apikey`.

## Management and UI contract

The dashboard presents three fixed OpenAI cards. Direct reports the caller/main-login path and has
no pool controls. Multi owns the main-plus-added account list, active selection, quota refresh,
cooldown, reauthentication, and failover controls. API owns masked key management and official API
model metadata. Reserved tier ids cannot be repurposed, deleted, or rewritten as custom providers.

Management reads and writes must preserve masked secrets, virtual model ids, and the distinction
between selected provider and resolved upstream model. The same ids must appear consistently in the
catalog, model visibility, subagents, injection settings, request logs, and persisted usage.
