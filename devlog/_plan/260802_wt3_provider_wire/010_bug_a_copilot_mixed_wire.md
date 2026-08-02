# 010 — Bug A: Copilot mixed-wire routing (#746 / #748)

Consumed by work-phase wp-a. Verified against dev@478354ee8. Model-by-model evidence and source URLs live in `000_plan.md` (claim ledger + evidence table) — this doc carries only the decision and its implementation consequences.

## Mechanism (decided)

The tree ALREADY owns the correct mechanism; this fix declares data, not new routing:

```text
hard wire pin
→ explicit user modelAdapters
→ registry modelWireDefaults      ← the fix adds entries here
→ provider-wide adapter
```

- `src/providers/registry.ts:101` — registry metadata owns mixed-wire defaults (`modelWireDefaults`).
- `src/providers/registry.ts:140` — registry defaults stay separate from persisted user overrides.
- `src/server/adapter-resolve.ts:14` — resolver implements the precedence above, preserving credentials/base URL through a copy.
- `src/providers/registry.ts:1552` — registry defaults constrained to recognized destinations + the two OpenAI wires.
- `src/server/responses/core.ts:1434` — final route resolves transport, then the effective model adapter.
- `src/providers/github-copilot-transport.ts:29` — transport has no model argument; do NOT branch here.

Rejected alternatives (with reasons): provider-wide `openai-responses` (breaks Copilot's Claude/Gemini/GPT-4/gpt-5-mini chat models); transport-level switch (wrong owner, no model arg); runtime endpoint probing (quota-cost + nondeterminism; live discovery hints are not routing metadata); new config flag (`modelAdapters` is already the operator escape hatch).

## File map

- MODIFY `src/providers/registry.ts` (github-copilot entry at :1470) — add `modelWireDefaults` with the conservative verified set:
  `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra` → `"openai-responses"` (bare strings, every inbound).
- MODIFY the same entry's cold-start seed. Exact before/after:
  - before: `models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro"]`
  - after: `models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra"]`
  - `defaultModel: "gpt-4o"` unchanged. Lead-only `gpt-5.4-nano` / `gpt-5.6-sol` are NOT added to the seed — they ship only as documented `modelAdapters` examples (evidence status in `000_plan.md`). `providerConfigSeed()` copies this list into saved config (`src/providers/derive.ts:105`), so the seed carries verified models only.
- NEW `tests/github-copilot-wire-defaults.test.ts` — focused suite (cases below).
- DOCS `docs-site/src/content/docs/reference/configuration/providers.md` (the authoritative `modelAdapters` contract lives at its :79) + maintained locale equivalents (ko, ja, zh-cn, ru) — the table currently carries DeepSeek-only wording and would contradict the new Copilot behavior. `docs-site/src/content/docs/guides/providers.md` gets a short routing-precedence note naming the built-in Copilot defaults and the `modelAdapters` escape hatch for lead-only models.
- NO CHANGES: `github-copilot-transport.ts`, `adapter-resolve.ts`, `types.ts`, `derive.ts`. The sampling/credential-replay parts of PR #746 are a separate parity/security unit — out of scope here.

## Selection rule (decision reference; full evidence in `000_plan.md`)

Built-in = field report in issue #748 AND independent corroboration. `gpt-5.6-sol`/`gpt-5.4-nano` fail that rule (lead-only) and stay out. Lookup is exact normalized-ID (`trim().toLowerCase()`, `registry.ts:1568`) — no family/snapshot prefix matching.

## Acceptance + activation scenarios

1. `gpt-5.4` via the github-copilot preset resolves to the Responses wire and the upstream request goes to the Responses endpoint, never `/chat/completions`. Activation: captured-upstream-URL test (runtime-wire proof, not just resolver proof).
2. All six built-in models resolve Responses on all three inbound wires (Responses, Chat Completions, Anthropic inbound). Activation: parametrized resolver + URL tests.
3. Explicit user `modelAdapters` override beats the registry default in BOTH directions (user pins a listed model back to chat; user maps `gpt-5.6-sol` to Responses). Activation: precedence tests.
4. Chat-served Copilot models (`gpt-4o`, `gpt-4.1`, `claude-sonnet-4`, `gemini-2.5-pro`, `gpt-5-mini`) still use chat completions. Activation: regression assertions on the existing seed set.
5. Unrelated providers are isolated (no wire change for non-copilot providers with same-named models). Activation: isolation test.
6. Credentials/base URL preserved through the resolved copy. Activation: adapter-resolve test shape per `adapter-resolve.ts:14`.

## Verification gate

`bun test tests/github-copilot-wire-defaults.test.ts` + `bun run typecheck` + `bun run test` (registry is shared) + `bun run privacy:scan`.
