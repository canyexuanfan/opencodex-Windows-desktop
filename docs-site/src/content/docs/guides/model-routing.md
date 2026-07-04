---
title: Model Routing
description: How opencodex decides which provider serves a given model id.
---

When Codex asks for a model, `router.ts` resolves it to exactly one configured provider. The rules are
checked **in order**; the first match wins.

## Precedence

1. **Explicit `provider/model`** — if the id contains `/` and the part before it is the name of a
   configured provider, that provider is used and the id is stripped to the part after the slash.

   ```text
   anthropic/claude-opus-4-8   →  provider "anthropic",   model "claude-opus-4-8"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   ```

   This is the unambiguous form, and the one Codex's model picker uses for routed models.

2. **A provider's `defaultModel`** — if any provider's `defaultModel` equals the id, that provider
   is used (id passed through unchanged).

3. **A provider's `models[]`** — if any provider lists the id in its `models[]`, that provider is used.

4. **Built-in prefix patterns** — the id is matched against known model-family prefixes, then routed
   to a configured provider of that name (or name-prefix):

   | Prefixes | Provider |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `gpt-`, `o1-`, `o3-`, `o4-` | `chatgpt` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

5. **Default provider** — if nothing matched, the id is sent to `config.defaultProvider` unchanged.
   (If no default provider is configured, routing throws.)

## API keys and environment variables

Whatever route is chosen, the provider's `apiKey` is resolved through `resolveEnvValue()`: a value of
`${OPENAI_API_KEY}` or `$OPENAI_API_KEY` is expanded from the environment at request time, so secrets
never need to live in `config.json`.

## Tips

- **Be explicit for routed models.** Prefer `provider/model` (rule 1) — it's unambiguous and
  matches what Codex shows in its picker after a catalog sync.
- **Seed `models[]` or `defaultModel`** on a provider so short ids (rule 2/3) resolve without the
  `provider/` prefix.
- **Prefix patterns are a convenience**, not a guarantee: they only resolve if a provider with that
  name (e.g. `anthropic`, `openai`, `groq`) is actually configured.

See [Configuration](/opencodex/reference/configuration/) for the provider fields these rules read.
