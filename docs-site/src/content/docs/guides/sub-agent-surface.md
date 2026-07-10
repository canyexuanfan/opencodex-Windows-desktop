---
title: Sub-agent Surface (v1 / base / v2)
description: Control how Codex spawns and manages sub-agents across all models.
---

opencodex lets you choose the multi-agent collaboration surface for every model in the catalog. The **Sub-agent** toggle in the dashboard and Models page controls this globally.

:::caution
**On the v2 surface (`multi_agent_v2`), a spawned sub-agent always inherits the parent session's model. `spawn_agent` model overrides are not honored, so v2 cannot spawn a sub-agent on a different model. Cross-model spawning is available only on the v1 surface.**
:::

## Modes

| Mode | Surface | Behavior |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | Classic namespaced agent tools with `send_input` / `close_agent` / `resume_agent`. A `spawn_agent` model override can start a sub-agent on a different model. |
| **base** (default) | Upstream pins | Restores upstream model pins: gpt-5.6-sol and gpt-5.6-terra use v2, gpt-5.6-luna uses v1, and unpinned models follow the Codex `multi_agent_v2` feature flag. Spawn behavior follows the surface that resolves for that model. |
| **v2** | `multi_agent_v2` | Flat `spawn_agent` tools with concurrent sessions and `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`. Every child inherits the parent model; model overrides are ignored. |

## How it works

The mode sets the `multi_agent_version` field on every catalog entry that Codex reads:

- **v1 mode**: forces `multi_agent_version = "v1"` on all entries, overriding upstream pins.
- **base mode**: restores upstream defaults. Pinned models get their snapshot value; unpinned models omit the field so the Codex feature flag decides.
- **v2 mode**: forces `multi_agent_version = "v2"` on all entries, overriding upstream pins.

The override is the final pass in both the live `/v1/models` catalog response and the on-disk catalog sync. Mode changes therefore apply consistently to newly created sessions, regardless of how an entry was built.

### Delegation model and effort

The dashboard's **Sub-agent delegation** picker stores an `injectionModel` and, optionally, an `injectionEffort`. These are delegation guidance settings, not a proxy-side spawn router.

`multiAgentGuidanceText` identifies the surface from the request's tools. On a **v1** turn, setting an injection model makes the proxy add proactive delegation guidance at any parent effort, name the exact model to pass to `spawn_agent`, and, when configured, name the exact `reasoning_effort`. Without an injection model, an injection effort has no effect.

On **v2**, Codex supplies its own proactive delegation guidance and the opencodex helper returns without injecting its v1 compatibility message. The current proxy therefore does not append `injectionModel` or `injectionEffort` to v2 turns. If v2 delegation guidance presents either preference, it remains advisory: there is no per-spawn cross-model request or proxy rewrite, and the child still runs on the parent session's model. The v2 surface can nevertheless apply a `reasoning_effort` actually passed to `spawn_agent`; effort is independent of the inherit-only model rule.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: click **v1**, **base**, or **v2**.
- **Models** page → top-row segmented control.
- Both pages have a **?** button that opens a help modal with a link back here.
- **Dashboard** → **Sub-agent delegation**: choose a preferred model and optional reasoning effort. On v2, remember that the model choice is guidance-only and cannot override inheritance.

### CLI

```bash
ocx v2 mode v1       # force all models to v1
ocx v2 mode default  # restore upstream pins
ocx v2 mode v2       # force all models to v2
ocx v2 status        # show current mode + Codex feature flag
```

### API

```bash
# Read the surface mode, feature flag, and thread limit
curl http://localhost:10100/api/v2

# Set the surface mode
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

The `/api/v2` PUT endpoint also accepts `enabled` (boolean, the Codex feature flag) and `maxConcurrentThreadsPerSession` (integer). It validates the request, saves the mode, resyncs the catalog, and reports that mode changes apply to new sessions.

The delegation picker uses a separate endpoint:

```bash
# Read the current model/effort and the available picker values
curl http://localhost:10100/api/injection-model

# Set both values
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# Clear both values
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` returns `model`, `effort`, the global `efforts` ladder, and enabled native/routed `available` models. For PUT, omitting `effort` keeps its current value, `null` clears it, and clearing `model` always clears the effort too. The API validates effort against the global Codex ladder; Codex still validates a spawn effort against the target catalog entry.

## Reasoning effort

The optional sub-agent effort setting is stored as `injectionEffort` and is meaningful only with an injection model. In the current proxy path it adds a `reasoning_effort` instruction to the v1 guidance; it does not change the parent session's effort. Independently, v2 can honor a `reasoning_effort` supplied to `spawn_agent` while still inheriting the parent model.

`ultra` ranks above `max` in the Codex catalog and adds automatic-delegation semantics, but it never reaches a provider as a literal wire value. Codex converts `ultra` to `max` at the client boundary. opencodex then keeps the provider request valid:

| Model | `max` on wire | `ultra` selection on wire |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh (via max, then `nativeEffortClamp`) |
| gpt-5.6-sol, gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | Not advertised by its exact upstream ladder |
| Routed models | Mapped or clamped by the adapter | Converted to max, then mapped or clamped by the adapter |

Catalog availability is independent of the v1/v2 mode. Reasoning-capable generated entries advertise `max` so direct sub-agent effort overrides validate; current generated routed entries also advertise `ultra`. Exact upstream model ladders are preserved, which is why gpt-5.6-luna stops at `max`.

## Context cap

The global context cap value defaults to 350k and limits the advertised `context_window` only for routed providers whose cap is enabled. Native OpenAI models keep their real context windows.

Change the value or the all-provider setting in the Models page, or toggle the cap next to an individual provider group header.
