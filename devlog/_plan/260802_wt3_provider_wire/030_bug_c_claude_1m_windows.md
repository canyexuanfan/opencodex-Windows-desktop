# 030 — Bug C: Claude 1M context windows, consolidated (#839 + #854)

Consumed by work-phase wp-c. Land as ONE fix crediting both PRs.

## P-phase stale check (2026-08-02, dev line after wp-b)

- `ANTHROPIC_MODEL_CONTEXT_WINDOWS` moved to registry.ts:227 (wp-a/wp-b shifted lines); still omits the three models. `ANTHROPIC_MODELS` (:226) includes them.
- Generated jawcode metadata (`src/generated/jawcode-model-metadata.ts`) ALREADY carries `claude-sonnet-4-6` at 1M, but the generator (`scripts/generate-jawcode-metadata.ts:30`) still pins `CONTEXT_WINDOW_OVERRIDES` forcing 200k — generator and committed output contradict; removing the override aligns both with the verified evidence. The byte-sync test skips without `JAWCODE_MODELS_JSON`, so no CI gate blocks either direction.
- `src/claude/desktop-profile.ts:260` already uses the authoritative `contextWindow >= 1_000_000` for `supports1m` — no change needed.
- `src/claude/model-info.ts:121` already gates the picker [1m] variant for `m.provider === "anthropic"` with `AUTO_CONTEXT_OFF` (audit 021 #3) — no change needed there either; the registry map fix makes the three models pass it.
- The open #854 half on THIS tree is `src/claude/agents-inject.ts`: `buildClaudeAgentDefs` (:75) marks generated subagent defs via `withOneMillionMarker(alias, windows, resolveAutoContext(config.claudeCode))` — the main-session auto-context predicate, so a 372K route is written `[1m]` into generated profiles. Port #854's `withSubagentContextMarker` (authoritative-only with AUTO_CONTEXT_OFF; a marked selector whose authoritative window is insufficient falls back to bare; unknown window keeps the selector as-was) for both the roster `push` and the self def.

## Evidence (externally verified)

Anthropic official: Opus 4.6 1M beta (2026-02-05 announcement), Opus 4.7 1M (2026-04-16 announcement + migration guide, standard API pricing), Sonnet 4.6 1M beta (2026-02-17 announcement); cross-checked against the platform model overview. API IDs: `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4-6`.

## File map

- MODIFY `src/providers/registry.ts:217` — `ANTHROPIC_MODEL_CONTEXT_WINDOWS` currently `{ "claude-sonnet-5": 1M, "claude-fable-5": 1M, "claude-opus-5": 1M, "claude-opus-4-8": 1M, "claude-haiku-4-5": 200k }` (verified dev@478354ee8 — the three 4.6/4.7 models are absent). Add all three at `1_000_000`.
- MODIFY `src/claude/agents-inject.ts` — port #854's `withSubagentContextMarker` for generated roster + self defs: mark only when the authoritative effective window (lookup order: exact selector → canonical `[1m]` form → bare) is ≥ 1M; strip an inherited unsafe marker to bare; preserve genuine routed `[1m]` ids (e.g. `kimi/k3[1m]`) and provider caps; case-insensitive marker spelling via the existing helpers. `model-info.ts` needs NO change (the guard already landed).
- MODIFY `scripts/generate-jawcode-metadata.ts` — delete `CONTEXT_WINDOW_OVERRIDES` (the sonnet-4-6 200k pin contradicts the committed 1M rows and the verified evidence); the committed generated file needs no edit.
- `src/claude/context-windows.ts` hosts only `shouldMarkOneMillion` (:83) + marker helpers — no map change there (audit-verified).
- Tests near existing coverage: picker row emission and generated-profile marker tests.
- MODIFY `tests/claude-agents-inject.test.ts` — port #854's three cases: (1) roster+self mark only authoritative 1M windows (372K native route with autoContext on stays bare); (2) catalog-derived 1M markers for Claude 4.6/4.7 via the real anthropic provider config + `buildClaudeContextWindows`; (3) genuine routed `[1m]` ids (`kimi/k3[1m]`) preserved for roster+self, and a 350K provider cap unmarks them.

## Acceptance + activation scenarios

1. `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` advertise `max_input_tokens: 1_000_000` and emit `[1m]` picker rows. Activation: model-info/picker test asserting the row per model.
2. A routed model whose effective window is capped below 1M (e.g. a 372K provider cap) does NOT get `[1m]` in generated profiles. Activation: fixture with a capped route asserting the marker is absent (this is #854's regression).
3. `claude-haiku-4-5` stays at 200k; existing 1M entries unchanged. Activation: existing suite green.
4. Case-insensitive `[1M]` marker spelling honored; genuine routed `[1m]` IDs preserved. Activation: parametrized test from #854's shape.
