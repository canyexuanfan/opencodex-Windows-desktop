---
title: Adapters
description: The five provider adapters — what each targets, how it builds requests, and its quirks.
---

An **adapter** translates between opencodex's internal request/response model and one provider wire
format. Every adapter implements the `ProviderAdapter` interface (`src/adapters/base.ts`):

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): { url; method; headers; body };
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  passthrough?: true;                                   // pipe raw, skip translation
}
```

`buildRequest` lowers an `OcxParsedRequest` into an upstream HTTP request; `parseStream` /
`parseResponse` lift the provider's reply back into internal `AdapterEvent`s, which
[`bridge.ts`](/opencodex/reference/architecture/#the-bridge) turns into Responses SSE.

## `openai-chat`

**Targets:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`) and every compatible
provider — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (local & cloud), and more.
**Auth:** `key` (Bearer).

- Converts internal messages to OpenAI roles; maps tools to `{type:"function", function:{…}}` and
  `tool_choice` (`auto`/`none`/`required` or a named function).
- **Rewrites Codex's GPT-5 identity prompt** to a model-agnostic intro so routed models don't claim to
  be OpenAI.
- **Clamps `reasoning_effort`** to what most providers accept (`minimal`→`low`, `xhigh`/`max`→`high`),
  and **omits it entirely** for ids in `provider.noReasoningModels`.
- Streams `delta.content` (text), `delta.reasoning_content` (thinking), and `delta.tool_calls[]`;
  collects `usage`.

## `openai-responses`

**Targets:** the OpenAI **Responses API**. **`passthrough: true`** — forwards the raw request body and
streams the response back **untranslated**.
**Auth:** `forward` (relay the caller's headers) or `key`.

- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`.
- In `forward` mode only a safe header allowlist is relayed (`FORWARD_HEADERS`): authorization,
  ChatGPT account id, and the OpenAI beta/originator/session headers. This is the ChatGPT-login path
  that also powers the [sidecars](/opencodex/guides/sidecars/).

## `anthropic`

**Targets:** Anthropic **Messages** (`/v1/messages`).
**Auth:** `key` (`x-api-key`) or `oauth` (Bearer + `anthropic-beta`, for Claude Pro/Max).

- Converts messages to Anthropic content blocks (text, base64 image, `tool_use`, `thinking`).
- **Extended thinking math:** Anthropic requires `max_tokens > thinking.budget_tokens`. The adapter
  maps reasoning effort to a budget (minimal 1024 … max 32000), then computes a safe `max_tokens` with
  output headroom, and **drops `temperature`/`top_p`** when thinking is enabled (Anthropic forbids
  them there).
- Always sends `anthropic-version: 2023-06-01`. Streams `content_block_delta` (`text_delta`,
  `thinking_delta`, `input_json_delta`).

## `google`

**Targets:** Google **Gemini** (`/v1beta/models/{model}:streamGenerateContent`).
**Auth:** `key` (`x-goog-api-key`).

- System prompt → `systemInstruction`; messages → `contents[]` (assistant → `model`); tools →
  `functionDeclarations`. Data-URL images → `inline_data`.
- No native reasoning; tool-call ids are synthesized (Gemini doesn't return them).

## `azure-openai`

**Targets:** **Azure OpenAI**. Wraps `openai-responses` (so also `passthrough: true`).
**Auth:** `key` via the `api-key` header (not Bearer).

- Delegates request building to the Responses passthrough, then swaps `Authorization` for `api-key`
  and appends an `api-version` query param (default `2025-04-01-preview`).

## Image utilities (`image.ts`)

Shared helpers used by the vision-aware adapters:

- `parseDataUrl(url)` — split a `data:<type>;base64,<data>` URL into `{ mediaType, base64 }` for
  Anthropic/Google image blocks.
- `contentPartsToText(content)` — flatten content parts to text for text-only tool messages
  (an undescribed image becomes a short `[image]` marker, never a token-exploding base64 blob).
