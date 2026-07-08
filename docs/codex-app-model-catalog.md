# Codex App Model Catalog Integration

Date: 2026-06-20

> **Archive note.** This is a dated design-rationale record, not current behavior
> documentation. For up-to-date behavior see the published docs at
> [lidge-jun.github.io/opencodex](https://lidge-jun.github.io/opencodex/) and the
> maintainer source-of-truth under [`structure/`](../structure). The current injected
> provider table name is `"OpenCodex Proxy"` (see `src/codex/inject.ts`).

This document records why opencodex routed models can appear in Codex App's model picker without
patching Codex App itself.

## Summary

Codex CLI, TUI, and App share the Codex home configuration surface. opencodex integrates by writing
Codex-native config and catalog files under the resolved `CODEX_HOME`:

- `$CODEX_HOME/config.toml`
- `$CODEX_HOME/opencodex.config.toml`
- `$CODEX_HOME/opencodex-catalog.json`
- `$CODEX_HOME/models_cache.json`

When Codex App reads the same config/catalog state, routed opencodex models are visible because they
look like valid Codex catalog entries.

## Required config shape

The global provider must be a root TOML key:

```toml
model_provider = "opencodex"
```

It must not be appended under whichever TOML table happened to be last. TOML root keys after a table
header become part of that table, which makes Codex ignore the provider as a global setting.

The custom model catalog path must also be a root TOML key:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

The provider block must advertise a Responses-compatible provider:

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://localhost:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`requires_openai_auth = true` is important for Codex App/TUI account-gated behavior. Codex derives
ChatGPT-account capability from the active provider; without this flag, fast-related UI can stay
hidden even when the user has ChatGPT auth.

## Catalog entry shape

opencodex does not generate minimal JSON entries. It clones a native Codex model catalog entry and
then changes the routed fields:

```text
slug = "<provider>/<model>"
display_name = "<provider>/<model>"
description = "Routed via opencodex -> <provider> ..."
priority = <picker priority>
visibility = "list"
```

Cloning a native entry preserves fields Codex's strict parser expects, including:

- `base_instructions`
- `supported_reasoning_levels`
- `default_reasoning_level`
- `shell_type`
- `supported_in_api`

This is why routed entries can behave like normal picker-visible Codex models.

## Fast tier handling

Codex uses a split between config spelling and runtime/catalog spelling:

| Surface | Value |
|---|---|
| `config.toml` persistence | `service_tier = "fast"` |
| catalog/request tier id | `priority` |
| feature gate | `[features].fast_mode = true` |
| provider/account gate | `requires_openai_auth = true` |

Native OpenAI passthrough models can keep fast metadata. Routed non-OpenAI models must not inherit
that metadata from the native template:

```text
delete additional_speed_tiers
delete service_tier
delete service_tiers
delete default_service_tier
```

This prevents fast from appearing for providers where Codex/OpenAI priority processing is not a valid
request option.

## Cache invalidation

Codex caches models in:

```text
$CODEX_HOME/models_cache.json
```

After changing providers, hidden models, featured models, or service-tier metadata, opencodex should
delete that cache so the next Codex process or model refresh sees the updated catalog.

## Verification

Useful probes:

```bash
codex doctor --json
codex debug models
ocx sync
ocx status
```

Expected high-level result:

- active model provider is `opencodex`
- provider uses ChatGPT auth reachability semantics
- native `gpt-*` entries keep fast support
- routed `<provider>/<model>` entries are `visibility = "list"`
- routed entries have no fast/service-tier metadata
