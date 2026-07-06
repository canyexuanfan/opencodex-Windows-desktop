---
title: Architecture
description: opencodex internals — module map, the AdapterEvent bridge, the request parser, and caching.
---

opencodex is a single Bun process. A request enters as OpenAI Responses, is normalized to an internal
model, routed, sent to a provider via an adapter, and bridged back to Responses SSE. See
[How It Works](/opencodex/getting-started/how-it-works/) for the end-to-end flow.

## Module map

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # base + openai-chat, openai-responses, anthropic, google, azure, image
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

## The parser

`responses/parser.ts` validates the incoming request with `responses/schema.ts` (Zod), then builds an
`OcxParsedRequest`:

- **Messages** — `input` items become a normalized `OcxMessage[]`: user / developer / assistant /
  toolResult. `reasoning` items become thinking blocks; `function_call`, `custom_tool_call`, and
  `tool_search_call` items become tool calls; their `*_output` counterparts become tool results.
- **Tools** — function tools pass through; **namespaced (MCP) tools are flattened** to
  `namespace__name` (and restored on the way back); **freeform** tools (e.g. `apply_patch`) and
  **tool_search** discovery tools are flagged; **hosted tools** (`web_search`, image gen, …) are
  dropped and re-injected by a sidecar only if it will handle them.
- **Images** — preserved as real content parts (data URL or remote https), never inlined as text.
- **Feature flags** — `_webSearch` (hosted web search requested) and `_structuredOutput`
  (`text.format` is json_schema / json_object).

## The bridge

`bridge.ts` turns the adapter's internal `AdapterEvent` stream back into Responses SSE that Codex
understands:

| AdapterEvent | Responses SSE emitted |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, item close |
| `tool_call_start` | `response.output_item.added` (type: `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (skipped for freeform / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `done` | `response.completed` (with usage) |
| `error` | `response.failed` (with `last_error`) |

The bridge also runs a **heartbeat keep-alive** (RC3): during upstream silence, it emits a
parser-ignored `response.heartbeat` SSE event every 2 seconds to re-arm Codex's idle timer. A
**stall deadline** of 150 ticks (5 minutes at the default 2 s interval) aborts the upstream and
closes the stream if the provider never resumes — preventing hung connections from blocking Codex
indefinitely.

Tool calls are disambiguated into three Responses item types using the namespace map, the freeform
set, and the tool-search set captured by the parser — so MCP namespaces, `apply_patch`-style freeform
tools, and client-executed `tool_search` all round-trip. A `buildResponseJSON()` variant produces a
single non-streaming response object from the same events.

## Transport and compaction

`server/index.ts` serves HTTP/SSE on `/v1/responses` by default. If Codex attempts a Responses
WebSocket upgrade while `websockets` is `false`, opencodex returns `426 upgrade_required`; Codex then
falls back to HTTP for that session. When `"websockets": true` is set, the same endpoint accepts the
upgrade and uses the WebSocket bridge.

Codex context compaction works for routed models. `server/responses.ts` handles
`POST /v1/responses/compact` by running an internal routed summarization turn and returning compacted
history, while `responses/parser.ts` and `bridge.ts` handle remote compaction v2
`compaction_trigger` turns by emitting exactly one synthetic `compaction` output item.

## Caching & the catalog

- `codex/model-cache.ts` keeps a per-provider, in-memory TTL cache of live `/models` results (default 5 min,
  matching Codex's own cache), with a stale-fallback when a fetch fails.
- `codex/catalog.ts` merges routed models into Codex's catalog as namespaced entries, ranks featured
  [subagent models](/opencodex/guides/codex-integration/#the-subagent-picker) first, filters
  `disabledModels`, and can fully restore the pristine catalog from a one-time backup.

## Reasoning effort

`reasoning-effort.ts` translates Codex's reasoning labels into each provider's wire values. The
Codex catalog only advertises labels Codex accepts (`low` / `medium` / `high` / `xhigh`), but
upstream providers may use different names (e.g. `max`) or support a smaller subset. The module:

- Defines the canonical `CODEX_REASONING_LEVELS` and their sort order.
- Clamps a requested effort to the closest supported tier when the exact level is unavailable.
- Resolves per-model and per-provider `reasoningEffortMap` overrides for custom wire mappings.
- Drops the effort entirely for models listed in `noReasoningModels`.

## Core types

The internal model lives in `types.ts`: `OcxParsedRequest`, `OcxContext`, the `OcxMessage` union,
`OcxContentPart` (text / image), `OcxToolCall`, `OcxTool`, `AdapterEvent`, and the config types
(`OcxConfig`, `OcxProviderConfig`). Two helpers are widely used: `namespacedToolName()` and
`modelInList()` (tolerant `:size`-tag matching for `noVisionModels` / `noReasoningModels`).
