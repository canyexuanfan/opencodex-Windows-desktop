# 010 — Bug A: Copilot mixed-wire routing (#746 / #748)

Consumed by work-phase wp-a. Verified against dev@478354ee8 (2026-08-02, sol-medium researcher; per-source evidence below).

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
  `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra` → `"openai-responses"`.
  Refresh the cold-start seed model list as justified by the same evidence (static seed is a cold-start fallback per the entry's FREEZE comment).
- NEW `tests/github-copilot-wire-defaults.test.ts` — focused suite (cases below).
- DOCS `docs-site/src/content/docs/guides/providers.md` + `docs-site/src/content/docs/reference/configuration.md` + maintained locales — name the built-in defaults and the `modelAdapters` escape hatch for lead-only models.
- NO CHANGES: `github-copilot-transport.ts`, `adapter-resolve.ts`, `types.ts`, `derive.ts`. The sampling/credential-replay parts of PR #746 are a separate parity/security unit — out of scope here.

## Model evidence table

| Model | Evidence | Status | In built-in set |
|---|---|---|---|
| `gpt-5.3-codex` | #748 field run + Pi metadata declares Responses | field-verified, corroborated | yes |
| `gpt-5.4` | exact tools+reasoning chat failure + successful Responses run in #748; litellm#23332 | verified Responses-required | yes |
| `gpt-5.4-mini` | #748 field run + Pi metadata | field-verified, corroborated | yes |
| `gpt-5.5` | #748 field run + Pi metadata | field-verified, corroborated | yes |
| `gpt-5.6-luna` | #748 field run + Pi metadata | field-verified, corroborated | yes |
| `gpt-5.6-terra` | #748 field run + Pi metadata | field-verified, corroborated | yes |
| `gpt-5.4-nano` | GitHub catalog + Pi labels; NOT in captured catalog, never field-run | lead-only | NO — document `modelAdapters` override |
| `gpt-5.6-sol` | #748 claims a run; JetBrains LLM-29711 shows tools+reasoning rejected on chat; no authoritative endpoint contract | lead-only | NO — document `modelAdapters` override |

Exact normalized-ID lookup only — no family/snapshot prefix matching (this tree's resolver behavior; PR #746's dated-snapshot matching was dropped at its final head too).

## Acceptance + activation scenarios

1. `gpt-5.4` via the github-copilot preset resolves to the Responses wire and the upstream request goes to the Responses endpoint, never `/chat/completions`. Activation: captured-upstream-URL test (runtime-wire proof, not just resolver proof).
2. All six built-in models resolve Responses on all three inbound wires (Responses, Chat Completions, Anthropic inbound). Activation: parametrized resolver + URL tests.
3. Explicit user `modelAdapters` override beats the registry default in BOTH directions (user pins a listed model back to chat; user maps `gpt-5.6-sol` to Responses). Activation: precedence tests.
4. Chat-served Copilot models (`gpt-4o`, `gpt-4.1`, `claude-sonnet-4`, `gemini-2.5-pro`, `gpt-5-mini`) still use chat completions. Activation: regression assertions on the existing seed set.
5. Unrelated providers are isolated (no wire change for non-copilot providers with same-named models). Activation: isolation test.
6. Credentials/base URL preserved through the resolved copy. Activation: adapter-resolve test shape per `adapter-resolve.ts:14`.

## Verification gate

`bun test tests/github-copilot-wire-defaults.test.ts` + `bun run typecheck` + `bun run test` (registry is shared) + `bun run privacy:scan`.
