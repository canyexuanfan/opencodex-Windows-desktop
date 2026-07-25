# WP5 — #404 혼합 게이트웨이 per-model adapter override

## 증상

OpenAI 호환 게이트웨이 하나에 Grok과 Gemini가 함께 붙어 있을 때, Grok 4.5로 web_search를
요청하면 reasoning만 담긴 빈 응답이 온다. 프록시는 정상 `response.completed`를 만든다.
같은 게이트웨이에 직접 `/v1/responses`로 호출하면 정상 동작한다.

## 근본 원인

모델을 선택한 뒤에도 provider의 단일 `adapter` 값이 모든 모델에 적용된다.

`src/router.ts:227`이 provider 객체와 native model ID를 그대로 묶어 반환한다.

```ts
return {
  providerName,
  provider: routedProviderConfig(providerName, provider),
  modelId,
};
```

현재 모델별 wire 예외는 하드코딩 하나뿐이다. `src/server/adapter-resolve.ts:11`:

```ts
const ANTHROPIC_WIRE_MODELS = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};
```

`localmodels/grok-4.5`는 여기 없으므로 provider 기본값 `openai-chat`이 남는다.

그리고 `src/responses/parser.ts:153`이 hosted tool을 의도적으로 제거한다.

```ts
else if (typeof t.name === "string" && t.type !== "web_search" && t.type !== "image_generation") {
  pushFn(t);
}
// OpenAI-hosted server-side tools ... are intentionally dropped
```

따라서 `web_search`가 `/chat/completions`에 전혀 도달하지 못한다. upstream이
`reasoning_content + finish_reason=stop`만 보내면 `src/bridge.ts:642`가 reasoning item을
닫고 677행이 완료 이벤트를 만들어, 관찰된 "reasoning 하나, message 없음, completed"가 된다.

### 실측 대조

현재 트리에서 같은 provider를 두 adapter로 probe한 결과:

```
openai-chat      → https://gateway/v1/chat/completions   (tools 소실)
openai-responses → https://gateway/v1/responses          tools:[{"type":"web_search"}] 보존
```

## 공식 문서 근거

xAI 공식 비교표는 Responses API가 search/code/MCP agentic tool을 native 지원하고
Chat Completions는 function calling만 지원하는 deprecated legacy endpoint라고 명시한다.
([Comparison with Chat Completions API](https://docs.x.ai/developers/model-capabilities/text/comparison))

공식 Web Search 문서는 `grok-4.5`를 `POST https://api.x.ai/v1/responses`와
`tools:[{"type":"web_search"}]`로 호출한다.
([Web Search](https://docs.x.ai/developers/tools/web-search))

즉 이 이슈의 OpenAI 호환 게이트웨이에서는 `/v1/responses`가 공식적으로 맞는 wire다.
이름이 `web_search`인 Chat Completions function은 xAI hosted search와 동등하지 않다.

## 설계: `modelAdapters`

```json
{
  "adapter": "openai-chat",
  "modelAdapters": { "grok-4.5": "openai-responses" }
}
```

- 키는 namespace/combo 해석이 끝난 upstream native model ID (combo alias는 target을 먼저
  라우팅하므로 public alias가 아니다)
- wildcard 없이 exact key
- 우선순위: 설정된 override → 기존 hardcoded pin → provider 기본값
- 필드가 없으면 현재 동작과 완전히 동일

`responsesModels: string[]` 대안은 "provider 기본이 Responses인데 일부만 Chat"인 반대
구성을 표현하지 못한다. 대칭적인 map이 낫다.

기존 모델별 필드 패턴 중 검증된 map(`modelSupportsReasoningSummaries`,
`modelOpenRouterRouting`)을 따른다. wire 선택은 요청의 의미 전체를 바꾸므로 validator 없는
배열 패턴(`noVisionModels`)보다 엄격해야 한다.

## Diff-level 변경안

### `src/types.ts` (721행 부근)

```ts
 adapter: string;
+/**
+ * Exact native model-id to adapter override. Lets one mixed gateway speak
+ * different wires per model (#404). Empty/absent keeps provider-wide behavior.
+ */
+modelAdapters?: Record<string, string>;
 baseUrl: string;
```

### `src/config.ts` (403행 부근)

`modelAdapterRecordConfigError()`를 추가하고 `configSchema.superRefine()`에 연결한다.

- plain own-properties object만 허용
- 키는 nonblank trimmed string
- 값은 `resolveAdapter()`가 실제 지원하는 adapter ID로 제한
- 잘못된 설정은 startup fallback 전에 명확한 진단으로 거부

### `src/server/auth-cors.ts` (202행 부근)

`providerManagementConfigError()`에서 같은 validator를 호출해 `POST /api/providers`도
동일하게 막는다. GUI는 범위 밖이므로 `safeConfigDTO()` 노출이나 PATCH editor 확장은 없다.

### `src/server/adapter-resolve.ts` (18행)

```ts
+  // Configured per-model override wins over the hardcoded wire pins below.
+  const configured = providerConfig.modelAdapters;
+  if (configured && Object.hasOwn(configured, modelId)) {
+    return { ...providerConfig, adapter: configured[modelId]! };
+  }
   const overrideSet = ANTHROPIC_WIRE_MODELS[providerName];
```

기존 `opencode-go` fallback은 그대로 보존한다.

### `src/server/responses/core.ts` (698행 부근)

현재 override는 adapter 생성 직전(897행)에만 적용된다. native model ID 정규화 직후로
앞당겨, 로그·`fastMode`·auth·sidecar 판단이 모두 effective adapter를 보게 한다.

```ts
+route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
```

897행 호출은 제거하거나 idempotent safety call로 남긴다.

### 나머지 inbound 경로

`src/server/chat-completions.ts:70`, `src/server/claude-messages.ts:570`,
`src/server/responses/compact.ts:177`은 `handleResponses()` 진입 전에 provider 기본
adapter로 sampling 제거·response-format 거부·compact passthrough를 판단한다. 이들도
effective adapter로 사전 분기해야 한다.

**WP3와의 충돌 주의**: `compact.ts`와 `core.ts`는 WP3에서도 수정된다. 반드시 WP3를 먼저
닫고 그 결과 위에서 이 phase의 P를 다시 stale 체크한다.

### 변경하지 않는 파일

- `src/adapters/openai-responses.ts` — 이미 `/v1` → `/v1/responses` 정규화와 hosted tool
  보존을 구현함
- `src/adapters/openai-chat.ts` — 현재 Chat wire 동작은 정상
- `src/router.ts` — custom provider 필드를 spread 보존하므로 `modelAdapters`가 이미 route까지 도달
- `src/providers/registry.ts`, `derive.ts` — #404는 custom provider JSON이라 불필요
- GUI 전체

## 회귀 테스트

### `tests/config.test.ts`

- 유효한 `{"grok-4.5":"openai-responses"}`가 disk load 후 보존
- `null`, array, blank key, unknown adapter, non-string value 거부
- 필드 없는 기존 config가 동일하게 load

### `tests/management-provider-validation.test.ts`

- `POST /api/providers`가 유효 map 저장, 같은 invalid matrix는 400
- reserved canonical `openai` seed에는 임의 map 추가를 계속 거부

### 새 파일 `tests/adapter-resolve.test.ts`

- map hit: Grok → `openai-responses`
- miss: Gemini → provider 기본 `openai-chat`
- map 없음: 기존 동작 유지
- `opencode-go/minimax-m3` hardcoded fallback 유지
- public selector가 native `grok-4.5`로 decode된 뒤 hit
- 원본 provider 객체가 mutate되지 않음

### 새 파일 `tests/server-model-adapter-override-e2e.test.ts`

`tests/server-key-failover-e2e.test.ts:117`의 로컬 `Bun.serve()` 패턴을 재사용해 한 provider에
두 모델을 태운다.

1. Gemini 요청 → `/v1/chat/completions`
2. Grok 요청 → `/v1/responses`
3. Grok upstream body에 `{type:"web_search"}` 보존
4. mock Responses SSE의 `web_search_call` + assistant message가 proxy SSE에도 나타남
5. combo alias도 동일 target으로 라우팅
6. override 없는 config는 `/chat/completions` 유지

## 판정

구현 가능하며 BLOCKED가 아니다. 필요한 Responses adapter와 URL 정규화가 이미 있고, route에
native model ID가 전달되며, 모든 retry adapter 재생성 지점이 `resolveWireProtocolOverride()`를
재호출한다. auth/baseUrl을 새로 만들지 않고 request-local clone의 adapter만 바꾼다.

## 검증 명령

```bash
bun test tests/config.test.ts tests/management-provider-validation.test.ts \
         tests/adapter-resolve.test.ts tests/server-model-adapter-override-e2e.test.ts \
         tests/openai-responses-passthrough.test.ts
bun run typecheck
```
