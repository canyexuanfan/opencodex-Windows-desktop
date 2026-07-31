# 050 — translator stream and serialized-tail bounds

Date: 2026-08-01  
Work phase: wp6  
Depends on: none; parallel-safe with 040  
Binding inputs: `000_state_store_inventory.md` §Translator-layer, `005_impl_roadmap.md` locked decision 5 and budget-scope split.

## Outcome

Bound every translator-owned accumulator without deleting translation duty. A normal
turn may contain 20 or more interleaved tool calls. The limits are therefore byte-based:

```ts
export const TRANSLATOR_MAX_CALL_ARGUMENT_BYTES = 2 * 1024 * 1024;
export const TRANSLATOR_MAX_TURN_BYTES = 32 * 1024 * 1024;
```

The per-call boundary covers one assembled argument stream. The per-turn boundary covers
all charged translator copies for that turn. Overflow cancels upstream and fails the
turn coherently; no completed frame contains truncated JSON or cross-wired ids.

## Shared budget and signature changes

### NEW `src/lib/translator-budget.ts`

```ts
export type TranslatorBufferKind =
  | "tool_args" | "output_collectors" | "reasoning" | "item_ids"
  | "tool_search_sources" | "cursor_queue" | "request_copies"
  | "serialized_tail";

export class TranslatorBudgetExceededError extends Error {
  readonly code = "translation_buffer_limit";
  constructor(readonly kind: TranslatorBufferKind, readonly limitBytes: number);
}
export interface TranslatorBudgetSnapshot {
  currentBytes: number;
  highWaterBytes: number;
  activeCalls: number;
  overflows: number;
}
export interface TranslatorBudget {
  openCall(id: string): void;
  appendCallBytes(id: string, bytes: number): void;
  closeCall(id: string): void;
  charge(kind: TranslatorBufferKind, bytes: number): void;
  release(kind: TranslatorBufferKind, bytes: number): void;
  snapshot(): TranslatorBudgetSnapshot;
  dispose(): void;
}
export function createTranslatorBudget(options?: TranslatorBudgetOptions): TranslatorBudget;
```

Use UTF-8 bytes from `TextEncoder`, not JS code units. `charge` happens before append,
and failed charge leaves both buffer and counters unchanged. Call ids in this tracker
are request-local only and never appear in metrics.

Modify `src/adapters/base.ts:3-39`:

```ts
export interface IncomingMeta {
  // existing fields unchanged
  translatorBudget?: TranslatorBudget;
}
export interface ProviderAdapter {
  parseStream(response: Response, budget?: TranslatorBudget): AsyncGenerator<AdapterEvent>;
}
```

At `src/server/responses/core.ts:1070-1116`, create one budget after body admission and
attach it to `IncomingMeta`; pass it to `adapter.parseStream(response, budget)` at current
`src/server/responses/core.ts:2479`. Cursor `runTurn` receives it through `IncomingMeta`.
Dispose in every terminal/cancel/error branch after 040 records the final high-water.

## Coherent overflow boundary

Adapter-local overflow is converted to one event:

```ts
{
  type: "error",
  status: 502,
  errorType: "upstream_error",
  code: "translation_buffer_limit",
  message: "upstream translation buffer exceeded the safe limit"
}
```

The bridge already has the required atomic failure path:

- `src/bridge.ts:437-468` (`failCurrentToolCall`) emits an incomplete item with no
  argument-done frame;
- `src/bridge.ts:709-734` uses that path for malformed assembled arguments;
- `src/bridge.ts:851-865` handles adapter `error`, fails any open call, and emits
  `response.failed`.

Route every overflow through the same `case "error"` branch and invoke `onCancel` once,
which reaches the request AbortController/upstream reader. Never call
`closeCurrentToolCall()` for overflow. Request-direction overflow is client input and
returns structured 413 `request_too_large` before upstream creation.

## Accumulator-by-accumulator diff

### Tool-call assembly

| Owner and current anchor | Exact charge point |
|---|---|
| OpenAI Chat `pendingToolCalls`, `src/adapters/openai-chat.ts:697-712,792-818,854-861` | `openCall` on first index/id; charge each `function.arguments` fragment before `call.args +=`; close after atomic emission. Keep index/id fallback and 20+ call interleaving. |
| Generic bridge current call, `src/bridge.ts:317,395-435,661-707` | Charge each `tool_call_delta` before line 684 append. Use the same budget for freeform and tool-search; release when the item moves to `finishedItems`. |
| Cursor calls, `src/adapters/cursor/protobuf-events.ts:152-183,348-410,436-478` | Charge streamed args per call id; count completed-call ids/name/schema maps in turn aggregate; preserve deferred atomic start/delta/end. |
| Anthropic, `src/adapters/anthropic.ts:793-795,837-890` | Charge `partial_json` before `currentToolCallJson +=`; on overflow cancel and never emit `tool_call_end`. |
| Kiro, `src/adapters/kiro.ts:769-782,857-975,1015-1108` | Charge each `ev.input` before `open.chunks.push`; private completion tool obeys the same 2 MiB rule; protocol terminal remains authoritative. |

Twenty-four calls of 1 MiB each must pass. One 2 MiB call passes exactly. One byte over
either per-call or 32 MiB aggregate fails the turn.

### Output collectors and reasoning carry

- Responses→Chat streaming maps/content/reasoning at
  `src/chat/outbound.ts:153-157,220,303-365`; non-stream fold at `:481-527`; terminal
  fold maps at `:553-636`: charge text, reasoning, ids, names, and argument fragments.
- Responses→Claude block/WebSearch state at `src/claude/outbound.ts:162-250` and
  non-stream content fold at `:600-629`: charge text/thinking/tool JSON/signatures before
  retaining; preserve block order and the real signature.
- Bridge message/reasoning/raw carry at `src/bridge.ts:300-324,334-393,650-658`:
  charge `hiddenRawReasoningText`, `compactionText`, current message/reasoning text, and
  pending redacted envelopes. Release a current buffer when its immutable finished item
  replaces it; finished items remain charged under `output_collectors` until terminal.
- Kiro `assistantText`, `outputChars`, `deferred`, `fallbackEvents`, and thinking parser
  state at `src/adapters/kiro.ts:725-782,792-922`: count only retained copies and release
  spliced queues. Do not double-charge `outputChars` if it aliases a fragment already
  charged as assistant/tool text; document one canonical owner for each copy.

### Item-id and tool-search maps

- `src/server/responses-item-id-repair.ts:7-12,51-84,169-205`: charge placeholder sets
  and both `output_index -> id` maps. Cap is aggregate only; overflow fails the stream
  before emitting a replacement id so one index never changes identity mid-stream.
- `buildToolBridgeMaps()` at `src/server/responses/collaboration.ts:102-115`: charge
  namespace/name strings and set entries while walking accepted tools. If the 32 MiB
  turn cap is exceeded, return 413 before adapter construction.
- Bridge `pendingWebSources` at `src/bridge.ts:321-331` and tool-search args at
  `:413-418,661-707`: charge URL/title source attribution and current args. Deduped
  sources release only after binding to the next assistant item.
- Cursor request-local KV in `src/adapters/cursor.ts:74-82` and
  `src/adapters/cursor/kv-store.ts:10-24`: charge cloned key/value bytes on set,
  subtract replacement, and fail the turn on overflow. Shared blobs remain 020-owned.
- Cursor MCP catalogs/results remain under 035's local payload caps; also report their
  per-stream current/high-water to this budget without making 040 evict them.

### Request-direction copies and images

`readJsonRequestBody()` at `src/server/request-decompress.ts:15-21,52-84` currently
overlaps raw/decoded `ArrayBuffer`, text, parsed object, translated object, and serialized
internal body. Add a request-copy high-water tracker with these insertion points:

- Responses `src/server/responses/core.ts:1079-1116`;
- Chat read/translation `src/server/chat-completions.ts:40-58,120-150` and
  `src/chat/inbound.ts:209-294`;
- Claude read/translation `src/server/claude-messages.ts:65-70,510-589,672` and
  `src/claude/inbound.ts:407-508`.

Retain the existing 256 MiB accepted-body compatibility cap. The 32 MiB translator
budget applies to newly retained translator structures, not the original accepted body;
the request-copy tracker is observe/high-water plus copy-release accounting. If a newly
materialized translation alone exceeds 32 MiB, return 413 and release original buffers
as soon as parsing/serialization no longer needs them. Never persist a partial converted
request. Image aliases at `src/server/responses/core.ts:1427-1429,1638,1768-1792` are
charged as request-local map entries; actual image normalization limits remain unchanged.

### Cursor producer queue and frame admission

Current queue/pending anchors are `src/adapters/cursor/live-transport.ts:457-493` and
`:727-761`; announced length is read in `src/adapters/cursor/framing.ts:68-80` but the
protocol maximum at `:4` is 4 GiB.

```ts
export const CURSOR_MAX_CONNECT_FRAME_BYTES = 32 * 1024 * 1024;
export const CURSOR_PRODUCER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
export const CURSOR_PRODUCER_QUEUE_MAX_MESSAGES = 4_096;
```

Change `tryDecodeConnectFrame(input, offset, maxPayloadBytes =
MAX_CONNECT_FRAME_PAYLOAD_BYTES)` to throw `payload_too_large` immediately after reading
the five-byte header and before waiting for/allocating payload. Live transport passes
32 MiB. Track queued protobuf message bytes/count; pause the HTTP/2 stream at high-water
and resume below 16 MiB. If a peer continues beyond the hard cap, close/cancel and emit
the coherent adapter error. Preserve FIFO terminal/tool ordering.

## Serialized promise tails

Resolve the open question as follows:

| Tail | Current anchor | Bound and rejection contract |
|---|---|---|
| Image retention | `src/images/fulfill.ts:12-24,89-106` | `MAX_PENDING_IMAGE_FULFILLMENTS = 64`; reserve before provider/artifact work; the 65th call returns an ordinary image tool error `image_fulfillment_busy`. Accepted write→prune→filter order is unchanged. |
| OAuth mutation | `src/oauth/store.ts:292-305` | `MAX_PENDING_OAUTH_MUTATIONS = 128`, 30 s queue-wait guard; overflow throws typed `OAuthMutationBusyError`; no accepted mutation is reordered or dropped. |
| Grok apply | `src/server/management/agent-settings-routes.ts:62-70,534-559` | No-body applies are equivalent and read persisted state at execution, so concurrent callers join one active `grokApplyFlight`; no FIFO chain. A stuck flight older than 120 s is not joined and the caller receives 409 `grok_apply_busy`. |

All three expose scalar current/peak/rejected/high-water counters to 040 as observed
in-flight fields. They are never global-budget eviction candidates.

## Regression cases

Add/extend the nearest existing suites with these exact cases:

- `24 interleaved OpenAI Chat tool calls complete without reordering`
- `one tool call admits exactly 2 MiB and rejects one byte over`
- `aggregate tool arguments admit exactly 32 MiB and fail one byte over`
- `overflow emits no arguments.done or completed tool item`
- `overflow cancels upstream once and bridge emits response.failed`
- `Responses to Chat and Claude collectors stay exact at the aggregate boundary`
- `Kiro deferred reasoning text and private completion share the turn cap`
- `reasoning and redacted carry fail coherently without a partial envelope`
- `item id repair overflow never changes an already emitted index id`
- `tool search source overflow preserves prior source attribution and fails turn`
- `request-local Cursor KV replacement releases charged bytes`
- `translated request over 32 MiB returns 413 before upstream creation`
- `Cursor announced 32 MiB overflow rejects after header before payload allocation`
- `Cursor queue pauses and resumes without reordering terminal or tool messages`
- `image fulfillment 65 returns busy before provider or artifact work`
- `OAuth mutation 129 returns busy while 128 accepted writes preserve order`
- `concurrent no-body Grok applies share one flight and a stale flight returns busy`.

Primary test files: `tests/openai-chat-parallel-stream.test.ts`, `tests/bridge.test.ts`,
`tests/cursor-protobuf-events.test.ts`, `tests/cursor-framing.test.ts`,
`tests/cursor-adapter.test.ts`, `tests/chat-completions-endpoint.test.ts`,
`tests/claude-outbound.test.ts`, `tests/kiro-stream.test.ts`,
`tests/responses-item-id-repair.test.ts`, `tests/request-decompress.test.ts`,
`tests/images/z-fulfill.test.ts`, `tests/oauth-store-multi.test.ts`, and
`tests/grok-management-api.test.ts`.

Verification:

```bash
bun test tests/openai-chat-parallel-stream.test.ts tests/bridge.test.ts \
  tests/cursor-protobuf-events.test.ts tests/cursor-framing.test.ts \
  tests/chat-completions-endpoint.test.ts tests/claude-outbound.test.ts tests/kiro-stream.test.ts \
  tests/images/z-fulfill.test.ts tests/oauth-store-multi.test.ts tests/grok-management-api.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`fix(translators): bound stream accumulation and serialized tails`

## Explicitly not changed

- No single-digit tool-call count cap; 20+ parallel calls are a normal acceptance case.
- No truncation of JSON, reasoning envelopes, ids, source attribution, or MCP payloads.
- No global-budget eviction of in-flight translator state.
- No request body compatibility-cap reduction, provider event semantic change, or
  reopening of the prior stream-path work.
