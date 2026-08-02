# 030 — Bug C: Claude 1M context windows, consolidated (#839 + #854)

Consumed by work-phase wp-c. Land as ONE fix crediting both PRs.

## Evidence (externally verified)

Anthropic official: Opus 4.6 1M beta (2026-02-05 announcement), Opus 4.7 1M (2026-04-16 announcement + migration guide, standard API pricing), Sonnet 4.6 1M beta (2026-02-17 announcement); cross-checked against the platform model overview. API IDs: `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4-6`.

## File map

- MODIFY `src/providers/registry.ts:217` — `ANTHROPIC_MODEL_CONTEXT_WINDOWS` currently `{ "claude-sonnet-5": 1M, "claude-fable-5": 1M, "claude-opus-5": 1M, "claude-opus-4-8": 1M, "claude-haiku-4-5": 200k }` (verified dev@478354ee8 — the three 4.6/4.7 models are absent). Add all three at `1_000_000`.
- MODIFY `src/claude/model-info.ts` — generated profiles: the `[1m]` marker must require the AUTHORITATIVE effective window ≥ 1M, not the main-session auto-context predicate (fixes #854's 372K-route-marked-`[1m]`). Honor provider caps and case-insensitive marker spelling; preserve genuine routed `[1m]` model IDs.
- `src/claude/context-windows.ts` hosts only `shouldMarkOneMillion` (:83) + marker helpers — no map change there (audit-verified).
- Tests near existing coverage: picker row emission and generated-profile marker tests.

## Acceptance + activation scenarios

1. `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` advertise `max_input_tokens: 1_000_000` and emit `[1m]` picker rows. Activation: model-info/picker test asserting the row per model.
2. A routed model whose effective window is capped below 1M (e.g. a 372K provider cap) does NOT get `[1m]` in generated profiles. Activation: fixture with a capped route asserting the marker is absent (this is #854's regression).
3. `claude-haiku-4-5` stays at 200k; existing 1M entries unchanged. Activation: existing suite green.
4. Case-insensitive `[1M]` marker spelling honored; genuine routed `[1m]` IDs preserved. Activation: parametrized test from #854's shape.
