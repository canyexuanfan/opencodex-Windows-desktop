---
title: Adapters
description: 五个 provider adapter —— 各自的目标、如何构建请求,以及各自的特性。
---

**adapter** 负责在 opencodex 的内部请求/响应模型与某个 provider 的传输格式之间进行转换。每个 adapter 都实现了 `ProviderAdapter` 接口(`src/adapters/base.ts`):

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): { url; method; headers; body };
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  passthrough?: true;                                   // pipe raw, skip translation
}
```

`buildRequest` 将 `OcxParsedRequest` 降级为上游 HTTP 请求;`parseStream` / `parseResponse` 将 provider 的回复提升回内部的 `AdapterEvent`,再由 [`bridge.ts`](/opencodex/zh-cn/reference/architecture/#the-bridge) 转换为 Responses SSE。

## `openai-chat`

**目标:** OpenAI **Chat Completions**(`POST {baseUrl}/chat/completions`)以及所有兼容的 provider —— xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama(本地和云端)等等。
**认证:** `key`(Bearer)。

- 将内部消息转换为 OpenAI 角色;将工具映射为 `{type:"function", function:{…}}` 和 `tool_choice`(`auto`/`none`/`required` 或某个具名函数)。
- **重写 Codex 的 GPT-5 身份提示词**,改为一段与模型无关的介绍,使被路由的模型不会自称是 OpenAI。
- **将 `reasoning_effort` 钳制**到大多数 provider 接受的范围(`minimal`→`low`,`xhigh`/`max`→`high`),并对 `provider.noReasoningModels` 中的 id **完全省略它**。
- 流式输出 `delta.content`(文本)、`delta.reasoning_content`(思考)以及 `delta.tool_calls[]`;并收集 `usage`。

## `openai-responses`

**目标:** OpenAI **Responses API**。**`passthrough: true`** —— 转发原始请求体,并将响应**未经转换**地流式回传。
**认证:** `forward`(转发调用方的 headers)或 `key`。

- `forward` URL → `{baseUrl}/responses`;`key` URL → `{baseUrl}/v1/responses`。
- 在 `forward` 模式下,仅转发一个安全的 header 白名单(`FORWARD_HEADERS`):authorization、ChatGPT account id,以及 OpenAI 的 beta/originator/session headers。这是 ChatGPT 登录路径,也为 [sidecars](/opencodex/zh-cn/guides/sidecars/) 提供支持。

## `anthropic`

**目标:** Anthropic **Messages**(`/v1/messages`)。
**认证:** `key`(`x-api-key`)或 `oauth`(Bearer + `anthropic-beta`,用于 Claude Pro/Max)。

- 将消息转换为 Anthropic 内容块(text、base64 image、`tool_use`、`thinking`)。
- **扩展思考的计算:** Anthropic 要求 `max_tokens > thinking.budget_tokens`。adapter 会将推理强度映射为一个预算(minimal 1024 … max 32000),然后计算出一个带有输出余量的安全 `max_tokens`,并在启用思考时**丢弃 `temperature`/`top_p`**(Anthropic 在此场景下禁止它们)。
- 始终发送 `anthropic-version: 2023-06-01`。流式输出 `content_block_delta`(`text_delta`、`thinking_delta`、`input_json_delta`)。

## `google`

**目标:** Google **Gemini**(`/v1beta/models/{model}:streamGenerateContent`)。
**认证:** `key`(`x-goog-api-key`)。

- 系统提示词 → `systemInstruction`;消息 → `contents[]`(assistant → `model`);工具 → `functionDeclarations`。Data-URL 图像 → `inline_data`。
- 无原生推理;tool-call id 是合成的(Gemini 不会返回它们)。

## `azure-openai`

**目标:** **Azure OpenAI**。封装 `openai-responses`(因此同样是 `passthrough: true`)。
**认证:** 通过 `api-key` header 进行 `key` 认证(而非 Bearer)。

- 将请求构建委托给 Responses passthrough,然后将 `Authorization` 替换为 `api-key`,并追加一个 `api-version` 查询参数(默认 `2025-04-01-preview`)。

## 图像工具(`image.ts`)

供具备视觉能力的 adapter 共用的辅助函数:

- `parseDataUrl(url)` —— 将 `data:<type>;base64,<data>` URL 拆分为 `{ mediaType, base64 }`,供 Anthropic/Google 图像块使用。
- `contentPartsToText(content)` —— 将内容部分扁平化为文本,用于纯文本的工具消息(未描述的图像会变成一个简短的 `[image]` 标记,而不是会导致 token 爆炸的 base64 数据块)。
