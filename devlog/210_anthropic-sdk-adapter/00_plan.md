# 210 — Anthropic SDK Adapter

Port `src/adapters/anthropic.ts` from raw fetch + manual SSE parsing to the official `@anthropic-ai/sdk`.

## Motivation

Current adapter (316 lines) does raw `fetch` → `POST /v1/messages` with manual `ReadableStream` + `getReader()` SSE parsing. This works but:

1. Manually handles SSE frame boundaries, partial chunks, CRLF edge cases
2. No automatic retry/backoff on 429/500 (bridge heartbeat masks this)
3. Extended thinking budget calculation is hand-rolled
4. Tool use response parsing is fragile (manually matching `content_block_start` types)
5. Any Anthropic API change (new event types, new thinking modes like "adaptive") requires manual adapter updates

## What the SDK provides

`@anthropic-ai/sdk` (v0.60+, Bun-native):

```ts
const client = new Anthropic({ apiKey });
const stream = client.messages.stream({
  model, messages, tools, max_tokens,
  thinking: { type: "enabled", budget_tokens },
  stream: true,
});

for await (const event of stream) {
  // event.type: message_start, content_block_start, content_block_delta,
  //             content_block_stop, message_delta, message_stop
}

const finalMessage = await stream.finalMessage(); // accumulated result
```

Key benefits:
- **Retry/backoff**: built-in for 429/5xx (configurable `maxRetries`)
- **Streaming helpers**: `.on("text", cb)`, `.on("thinking", cb)`, `.on("tool_use", cb)` 
- **Type safety**: `ContentBlockStartEvent`, `ThinkingDelta`, `ToolUseBlock` etc.
- **Token counting**: `stream.finalMessage().usage`
- **Abort**: `stream.controller.abort()`
- **MCP helpers**: `mcpTools()` for MCP server tool integration
- **Bun support**: officially supported runtime

## Changes

### File map

| File | Action | Description |
|------|--------|-------------|
| `package.json` | MODIFY | Add `@anthropic-ai/sdk` dependency |
| `src/adapters/anthropic.ts` | MODIFY | Replace fetch+SSE with SDK `messages.stream()` |
| `tests/anthropic-adapter.test.ts` | NEW | Unit tests for SDK-based adapter |

### Adapter rewrite plan

**Current flow** (raw fetch):
```
buildRequest() → { url, method, headers, body }
*streamResponse(response) → yield AdapterEvent from manual SSE parsing
```

**New flow** (SDK):
```
buildRequest() → { sdkParams: MessageCreateParams }
*streamResponse() → Anthropic.messages.stream(sdkParams) → yield AdapterEvent from SDK events
```

Key mapping:
| SDK event | AdapterEvent |
|-----------|-------------|
| `content_block_start` (type=text) | `{ type: "text_delta", text: "" }` (init) |
| `content_block_delta` (type=text_delta) | `{ type: "text_delta", text }` |
| `content_block_start` (type=thinking) | `{ type: "thinking_delta", thinking: "" }` |
| `content_block_delta` (type=thinking_delta) | `{ type: "thinking_delta", thinking }` |
| `content_block_start` (type=tool_use) | `{ type: "tool_start", id, name }` |
| `content_block_delta` (type=input_json_delta) | `{ type: "tool_delta", args }` |
| `content_block_stop` (tool) | `{ type: "tool_end" }` |
| `message_stop` | `{ type: "done", usage }` |
| error | `{ type: "error", ... }` |

### OAuth token injection

Current: `provider.apiKey` is set per-request in `server.ts` before calling the adapter.

SDK approach: create a new `Anthropic` client per-request with the current token:
```ts
const client = new Anthropic({
  apiKey: provider.apiKey,
  baseURL: provider.baseUrl,
  maxRetries: 2,
});
```

This is fine — `Anthropic` construction is lightweight (no connection pool).

### Abort signal threading

Current: `AbortSignal` passed to `fetch()`.

SDK: use `stream.controller.abort()` or pass signal via `fetchOptions`:
```ts
const stream = client.messages.stream(params, {
  signal: abortSignal,
});
```

### Extended thinking

Current: manual `reasoningBudget()` → `body.thinking = { type: "enabled", budget_tokens }`.

SDK: same shape, but type-checked:
```ts
thinking: parsed.options.reasoning
  ? { type: "enabled", budget_tokens: reasoningBudget(parsed.options.reasoning) }
  : undefined,
```

SDK also supports `{ type: "adaptive" }` for automatic thinking — future-proofs the adapter.

## Risks

1. **Dependency size**: ~700KB added to node_modules (not in npm tarball since it's a runtime dep)
2. **SDK version churn**: Anthropic SDK is pre-1.0, breaking changes possible
3. **Custom baseUrl**: SDK supports `baseURL` option — tested with direct Anthropic, needs verification with third-party Anthropic-compatible endpoints (e.g. opencode-go Messages models)
4. **Error mapping**: SDK throws typed errors (`RateLimitError`, `AuthenticationError`) — need to map to opencodex's `formatErrorResponse` pattern

## Verification

- `bun x tsc --noEmit`
- `bun test tests` (all existing + new anthropic-adapter tests)
- E2E: `codex -m "anthropic/claude-sonnet-4-6" "hello"` with streaming
- E2E: extended thinking with `xhigh` effort
- E2E: tool use round-trip (web search sidecar)
- E2E: OAuth token (Anthropic OAuth login → routed request)

## Estimate

C2 (single adapter file rewrite, one new dep, existing tests as regression gate). ~2-3 hours implementation + verification.
