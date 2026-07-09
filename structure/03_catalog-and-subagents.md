# Catalog And Subagents SOT

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback, and emits
  gpt-5.6 natives from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` (routed namespaced ids are excluded; BARE native slugs flip the
  catalog entry to `visibility: "hide"` and drop from the bare `/v1/models` list);
- strips native-only service tier and WebSocket metadata unless explicitly enabled;
- backs up the pristine catalog once to `~/.opencodex/catalog-backup.json`;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

Codex App model picker visibility comes from this shared catalog, not from patching the App.

## Entry shape

Routed entries keep Codex-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug and
display name use `provider/model`.

## Native passthrough

Native OpenAI entries remain available for ChatGPT passthrough. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability.

## Subagents

Codex `spawn_agent` advertises only the highest-priority first five catalog models. `subagentModels`
is capped at five ids and may contain routed `provider/model` slugs or native model slugs. Startup
seeds native GPT defaults only when the field is unset; an explicit empty list persists.
