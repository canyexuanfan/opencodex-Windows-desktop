---
title: 어댑터
description: 다섯 가지 프로바이더 어댑터 — 각각의 대상, 요청 구성 방식, 그리고 고유한 특이점.
---

**어댑터**는 opencodex의 내부 요청/응답 모델과 하나의 프로바이더 와이어 포맷 사이를 변환합니다.
모든 어댑터는 `ProviderAdapter` 인터페이스(`src/adapters/base.ts`)를 구현합니다:

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): { url; method; headers; body };
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  passthrough?: true;                                   // pipe raw, skip translation
}
```

`buildRequest`는 `OcxParsedRequest`를 업스트림 HTTP 요청으로 낮춰주고, `parseStream` /
`parseResponse`는 프로바이더의 응답을 내부 `AdapterEvent`로 다시 끌어올립니다. 이는
[`bridge.ts`](/opencodex/ko/reference/architecture/#the-bridge)가 Responses SSE로 변환합니다.

## `openai-chat`

**대상:** OpenAI **Chat Completions**(`POST {baseUrl}/chat/completions`)와 모든 호환
프로바이더 — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama(로컬 및 클라우드) 등.
**인증:** `key` (Bearer).

- 내부 메시지를 OpenAI 역할로 변환합니다. 툴을 `{type:"function", function:{…}}`과
  `tool_choice`(`auto`/`none`/`required` 또는 명명된 함수)로 매핑합니다.
- **Codex의 GPT-5 정체성 프롬프트를 다시 작성**하여 모델 비종속적인 인트로로 바꿉니다. 따라서 라우팅된
  모델이 자신을 OpenAI라고 주장하지 않습니다.
- **`reasoning_effort`를 클램핑**하여 대부분의 프로바이더가 받아들이는 값으로 맞추고
  (`minimal`→`low`, `xhigh`/`max`→`high`), `provider.noReasoningModels`에 있는 id에 대해서는
  **완전히 생략**합니다.
- `delta.content`(텍스트), `delta.reasoning_content`(thinking), `delta.tool_calls[]`를
  스트리밍하고, `usage`를 수집합니다.

## `openai-responses`

**대상:** OpenAI **Responses API**. **`passthrough: true`** — 원본 요청 본문을 그대로 전달하고
응답을 **번역 없이** 다시 스트리밍합니다.
**인증:** `forward`(호출자의 헤더를 중계) 또는 `key`.

- `forward` URL → `{baseUrl}/responses`; `key` URL → `{baseUrl}/v1/responses`.
- `forward` 모드에서는 안전한 헤더 허용 목록(`FORWARD_HEADERS`)만 중계됩니다: authorization,
  ChatGPT account id, 그리고 OpenAI beta/originator/session 헤더. 이는
  [사이드카](/opencodex/ko/guides/sidecars/)에도 동력을 공급하는 ChatGPT 로그인 경로입니다.

## `anthropic`

**대상:** Anthropic **Messages**(`/v1/messages`).
**인증:** `key`(`x-api-key`) 또는 `oauth`(Bearer + `anthropic-beta`, Claude Pro/Max용).

- 메시지를 Anthropic content 블록(text, base64 image, `tool_use`, `thinking`)으로 변환합니다.
- **확장 thinking 계산:** Anthropic은 `max_tokens > thinking.budget_tokens`를 요구합니다. 어댑터는
  reasoning effort를 budget으로 매핑하고(minimal 1024 … max 32000), 출력 여유를 둔 안전한
  `max_tokens`를 계산한 뒤, thinking이 활성화되면 **`temperature`/`top_p`를 제거**합니다(Anthropic은
  그 경우 이를 금지함).
- 항상 `anthropic-version: 2023-06-01`을 전송합니다. `content_block_delta`(`text_delta`,
  `thinking_delta`, `input_json_delta`)를 스트리밍합니다.

## `google`

**대상:** Google **Gemini**(`/v1beta/models/{model}:streamGenerateContent`).
**인증:** `key`(`x-goog-api-key`).

- 시스템 프롬프트 → `systemInstruction`; 메시지 → `contents[]`(assistant → `model`); 툴 →
  `functionDeclarations`. data-URL 이미지 → `inline_data`.
- 네이티브 reasoning 없음. tool-call id는 합성됩니다(Gemini는 이를 반환하지 않음).

## `azure-openai`

**대상:** **Azure OpenAI**. `openai-responses`를 감쌉니다(따라서 마찬가지로 `passthrough: true`).
**인증:** `api-key` 헤더를 통한 `key`(Bearer 아님).

- 요청 구성을 Responses passthrough에 위임한 다음, `Authorization`을 `api-key`로 교체하고
  `api-version` 쿼리 파라미터(기본 `2025-04-01-preview`)를 덧붙입니다.

## 이미지 유틸리티 (`image.ts`)

비전을 인식하는 어댑터들이 공유하는 헬퍼:

- `parseDataUrl(url)` — `data:<type>;base64,<data>` URL을 `{ mediaType, base64 }`로 분리하여
  Anthropic/Google 이미지 블록에 사용합니다.
- `contentPartsToText(content)` — 텍스트 전용 툴 메시지를 위해 content 파트를 텍스트로 평탄화합니다
  (설명되지 않은 이미지는 토큰을 폭증시키는 base64 blob이 아니라 짧은 `[image]` 마커가 됩니다).
