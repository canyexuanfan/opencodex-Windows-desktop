---
title: Sub-agent Surface (v1 / base / v2)
description: Control how Codex spawns and manages sub-agents across all models.
---

opencodex lets you choose the multi-agent collab surface for every model in the catalog. The **Sub-agent** toggle in the dashboard and Models page controls this globally.

## Modes

| Mode | Surface | Behavior |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | Classic single-thread agent. One model per session, sequential tool calls. `send_input` / `close_agent` / `resume_agent` verbs. |
| **base** (default) | Upstream pins | Respects the upstream model pins: gpt-5.6-sol and gpt-5.6-terra use v2, gpt-5.6-luna uses v1, all others follow the Codex `multi_agent_v2` feature flag. |
| **v2** | `multi_agent_v2` | Multi-thread agent with `spawn_agent`. Parallel tool calls, concurrent sessions, `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` verbs. |

## How it works

The mode sets the `multi_agent_version` field on every catalog entry that Codex reads:

- **v1 mode**: forces `multi_agent_version = "v1"` on all entries, overriding upstream pins.
- **base mode**: restores upstream defaults — pinned models get their snapshot value, unpinned models get `null` (Codex feature flag decides).
- **v2 mode**: forces `multi_agent_version = "v2"` on all entries, overriding upstream pins.

The override runs as a final pass in both the live `/v1/models` endpoint and the on-disk catalog sync, so it always takes effect regardless of how the entry was built.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: click **v1**, **base**, or **v2**.
- **Models** page → top row segmented control.
- Both pages have a **?** button that opens a help modal with a link back here.

### CLI

```bash
ocx v2 mode v1      # force all models to v1
ocx v2 mode default  # restore upstream pins
ocx v2 mode v2      # force all models to v2
ocx v2 status       # show current mode + codex feature flag
```

### API

```bash
# Read
curl http://localhost:10100/api/v2

# Set
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

The API also accepts `enabled` (boolean, for the Codex feature flag) and `maxConcurrentThreadsPerSession` (integer) in the same PUT body.

## Reasoning effort

The **ultra** reasoning level is always advertised in the catalog regardless of the v2 toggle. The wire clamp (`nativeEffortClamp`) converts ultra → the model's real top rung on the wire:

| Model | ultra on wire | max on wire |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh |
| gpt-5.6-sol, gpt-5.6-terra | ultra (native) | max (native) |
| gpt-5.6-luna | max (no native ultra) | max |
| Routed models | mapped by adapter | mapped by adapter |

`max` is always present on every reasoning-capable entry so sub-agent spawns with `reasoning_effort: "max"` always validate against the catalog.

## Context cap

The global context cap (default 350k) limits the advertised `context_window` for routed provider models. Native OpenAI models use their real context windows and are not affected by this cap.

Change the cap in the Models page dropdown, or per-provider with the toggle next to each provider group header.
