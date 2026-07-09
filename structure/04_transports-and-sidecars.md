# Transports And Sidecars SOT

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output.

Native OpenAI/ChatGPT passthrough uses `openai-responses` with `authMode: "forward"`, forwarding only
the allowed Codex/OpenAI auth/session headers.

`POST /v1/responses/compact` handles remote compaction v1 before the generic `/v1/responses` branch
and before the `/v1/*` guard. Unknown `/v1/*` paths return JSON 404 errors instead of falling through
to GUI static serving.

## WebSocket

The WebSocket endpoint exists at `/v1/responses`, but discovery is opt-in:

```json
{
  "websockets": false
}
```

`websocketsEnabled(config)` is true only for an explicit `true`. When false, opencodex removes
`supports_websockets` from injected provider tables and routed catalog entries, keeping Codex on
HTTP/SSE. When true, Codex may use Responses WebSocket frames handled by `src/server/ws-bridge.ts`.
If Codex still attempts a WebSocket upgrade while the feature is disabled, `/v1/responses` rejects
the upgrade with 426 so Codex falls back to HTTP cleanly.

The endpoint handles `response.create`, ignores `response.processed`, supports warmup
`generate: false`, and feeds the same request pipeline as HTTP/SSE.

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.

## Heartbeat and stall deadline

The HTTP/SSE bridge emits `response.heartbeat` events during upstream silence to re-arm Codex's idle
timer. A bounded stall deadline (150 ticks = 5 minutes at the default 2 s interval) closes the stream
and cancels the upstream request if no real events arrive, preventing indefinitely hung connections.

## Reasoning and tool-result compatibility

Native OpenAI passthrough sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.

These compatibility guards are covered by focused tests and should stay close to the adapters that
need them.

## Parallel tool calls (default-on for chat providers)

The openai-chat adapter buffers ALL streamed `tool_calls` deltas (keyed by `index`, falling back to
`id`, then last-seen) and flushes them as atomic start/delta/end sequences at the terminal signal.
This is required by the bridge's sequential tool-call contract and makes interleaved parallel
deltas, id-only-first-chunk continuations, and whole-chunk multi-call frames all safe.

Parallel tool calls are DEFAULT-ON for openai-chat providers: the adapter follows Codex's
request-level `parallel_tool_calls` bit (default true) and routed catalog entries advertise
`supports_parallel_tool_calls`. `OcxProviderConfig.parallelToolCalls: false` is the per-provider
opt-out (registry-seeded, router-backfilled; an explicit user value always wins). Non-chat
adapters advertise the catalog bit only on explicit `true`; cursor keeps its own special-casing.
Providers with flaky parallel streaming can be opted out individually. Evidence and provider
ledger: `devlog/_plan/260709_parallel_tool_calls/`.

## Reasoning display parity (hideThinkingSummary)

`hideThinkingSummary` (request reasoning summary absent/"none" — the routed catalog default) is
honored by BOTH reasoning paths: anthropic `thinking_delta` AND raw `reasoning_raw_delta`
(openai-chat `reasoning_content`, kiro tags). Hidden reasoning emits an envelope-only reasoning
item (`summary: []`, txt-only `ocxr1:` `encrypted_content`, no text deltas) — invisible in the
Codex app, so tool cells group like native models — while the text still round-trips for
`preserveReasoningContentModels` replay. Visible mode (summary "auto") keeps the raw
`content[reasoning_text]` shape. Diagnosis and codex-rs grouping evidence:
`devlog/_plan/260709_native_response_pattern/`.

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` retries only
connection-reset-shaped rejections (up to 3 total attempts, jittered backoff, warn-logged);
timeouts, aborts, `ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never
retried. Guarded paths: the ChatGPT passthrough and generic adapter fetch in
`src/server/responses.ts`, the vision/web-search sidecars, and the web-search loop's direct-fetch
fallback. Adapters with their own `fetchResponse` (kiro, cursor, google) keep their own retry
policies; kiro imports the shared abort/sleep helpers from this module.

## Sidecars

Web search and vision sidecars only run when a forward ChatGPT provider/login exists and the main
request needs that capability.

| Sidecar | Default model | Activation |
| --- | --- | --- |
| `web-search/` | `gpt-5.4-mini` | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | `gpt-5.4-mini` | Input contains images for a model listed in `noVisionModels`. |

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
