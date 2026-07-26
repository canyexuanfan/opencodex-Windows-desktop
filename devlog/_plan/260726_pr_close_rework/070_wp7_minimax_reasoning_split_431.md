# WP7 — PR #431 MiniMax split reasoning (축소 슬라이스)

대상: PR #431 (H-H-E), head `9568cb81`. `git merge-tree` clean.
기여자가 이전 응답 순서 리뷰를 현재 head에서 반영했다.
MiniMax 공식 문서로 `reasoning_split`, M3의 `adaptive|disabled` thinking 제어,
M 시리즈 모델명과 context window를 확인했다
(https://platform.minimax.io/docs/api-reference/text-openai-api).

## 범위 축소 (STRICT)

DO NOT TAKE — 런타임 동작에 불필요하고 OAuth/자격증명/safe-DTO 리뷰 표면을 만든다:

```
src/oauth/index.ts
src/oauth/login-cli.ts
src/server/auth-cors.ts
```

불필요한 이유: `routeModel()`이 매 라우팅마다 registry capability를 backfill하고,
`enrichProviderFromRegistry()`가 저장된 config를 커버하며, GUI는 현재
`reasoningSplitModels`를 편집하지 않는다.

TAKE:

```
src/adapters/openai-chat.ts
src/providers/derive.ts
src/providers/registry.ts
src/router.ts
src/types.ts
tests/adapter-usage.test.ts
tests/minimax-reasoning-split.test.ts
tests/openai-chat-eof.test.ts
tests/provider-registry-parity.test.ts
```

## MODIFY `src/adapters/openai-chat.ts`

요청 본문 구성 후 추가:

```ts
if (modelInList(provider.reasoningSplitModels, parsed.modelId)) {
  body.reasoning_split = true;
}
```

M3의 adaptive 토글 허용:

```ts
if (
  reasoningEffort === "enabled"
  || reasoningEffort === "disabled"
  || reasoningEffort === "adaptive"
) {
  body.thinking = { type: reasoningEffort };
}
```

스트리밍 순서는 reasoning이 먼저, content가 나중이어야 한다:

```ts
if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
  yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
}
if (typeof delta.content === "string" && delta.content.length > 0) {
  yield { type: "text_delta", text: delta.content };
}
```

비스트리밍도 동일 순서:

```ts
if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
  events.push({ type: "reasoning_raw_delta", text: msg.reasoning_content });
}
if (typeof msg.content === "string") {
  events.push({ type: "text_delta", text: msg.content });
}
```

## 타입 확장

`reasoningSplitModels?: string[]`를 아래 4개 타입에 추가한다.

- `OcxProviderConfig` (`src/types.ts`)
- `ProviderRegistryEntry`
- `ProviderConfigSeed`
- `DerivedKeyLoginProvider`

`routedProviderConfig()`에서 병합하고, `enrichProviderFromRegistry()`에서는
값이 없을 때만 채운다.

## 회귀 테스트

`tests/adapter-usage.test.ts`에 아래 테스트를 유지한다.

```ts
test("OpenAI-compatible streaming emits split reasoning before final content", async () => {
  const adapter = createOpenAIChatAdapter(provider);
  const response = new Response([
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"raw stream\",\"content\":\"answer\"}}]}\n\n",
    "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
    "data: [DONE]\n\n",
  ].join(""));

  const events = [];
  for await (const event of adapter.parseStream(response)) events.push(event);

  expect(events).toEqual([
    { type: "reasoning_raw_delta", text: "raw stream" },
    { type: "text_delta", text: "answer" },
    {
      type: "done",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cachedInputTokens: 2,
        reasoningOutputTokens: 1,
      },
    },
  ]);
});
```

현재 head에 비스트리밍/스트리밍/빈 delta/finish-only/중단된 EOF 커버리지가 이미 있다.

## RED 근거 정정 (A-gate blocker 6)

최초 안의 RED 설명은 **사실과 다르다.** `dev:src/adapters/openai-chat.ts:703` 기준으로
baseline은 응답에 `reasoning_content`가 있으면 이미 `reasoning_raw_delta`를 방출한다.
위 테스트가 RED인 진짜 이유는 baseline이 `content`를 reasoning보다 **먼저** 내보내기
때문이지, `reasoning_split`을 지원하지 않아서가 아니다.

즉 위 테스트는 응답 순서 회귀일 뿐, 요청 게이트(`body.reasoning_split = true`)가
활성화되는지는 전혀 증명하지 못한다. 요청 측 테스트를 별도로 추가한다.

## 회귀 테스트 2 — 요청 게이트 활성화 (필수)

A-gate R2 blocker 5 반영: 최초 안의 `configWithMiniMax()` / `parsedWith()`는 존재하지 않는
헬퍼였다. `git show pr-431:tests/minimax-reasoning-split.test.ts`로 확인한 실제 헬퍼는
`minimaxRoute()`, `body()`, `parsed()` 세 개다. 파일이 `dev`에는 없고 이 PR이 신규 추가한다.

실제 헬퍼 시그니처 (PR #431이 추가하는 파일 상단):

```ts
function parsed(modelId: string, reasoning?: ReasoningEffort): OcxParsedRequest
function body(provider: OcxProviderConfig, modelId: string, reasoning?: ReasoningEffort): Record<string, unknown>
function minimaxRoute(modelId = "MiniMax-M3", provider: Partial<OcxProviderConfig> = {}): { provider: OcxProviderConfig; modelId: string }
```

`body()`가 이미 `buildRequest` 결과를 JSON 파싱해 돌려주므로 어댑터를 직접 만들 필요가 없다.

APPEND: `tests/minimax-reasoning-split.test.ts`의 `describe("MiniMax split reasoning")` 블록 안

```ts
  test("a routed MiniMax model sends reasoning_split in the request body", () => {
    const route = minimaxRoute("MiniMax-M2");
    expect(body(route.provider, route.modelId)).toMatchObject({
      model: "MiniMax-M2",
      reasoning_split: true,
    });
  });

  test("a model outside reasoningSplitModels does not send reasoning_split", () => {
    const route = minimaxRoute("some-other-model");
    expect(body(route.provider, route.modelId).reasoning_split).toBeUndefined();
  });
```

`minimaxRoute()`가 `routeModel()`을 거치므로 registry backfill 경로까지 함께 밟는다.
즉 `reasoningSplitModels`가 registry 시드에서 provider config로 실제 전달되는지도 증명된다.

RED→GREEN 근거: 수정 전에는 `body.reasoning_split`이 항상 `undefined`라 첫 테스트의
`toMatchObject`가 실패한다. 두 번째 테스트는 게이트가 무분별하게 켜지지 않음을 잠그는
음성 대조군이며 수정 전후 모두 통과해야 한다 — 수정 후에도 통과해야 의미가 있다.

## 활성화 시나리오

새 분기: `modelInList(provider.reasoningSplitModels, ...)` 게이트와 `adaptive` 분기.
위 테스트가 split 경로를 활성화하고, `tests/minimax-reasoning-split.test.ts`가
registry 시드에서 해당 모델 목록이 실제로 채워지는지 확인한다.

## 커밋

```
feat(minimax): support split reasoning and adaptive thinking (#431)

Co-authored-by: Hussein <59151492+H-H-E@users.noreply.github.com>
```

## 검증

```bash
bun test --isolate tests/adapter-usage.test.ts tests/minimax-reasoning-split.test.ts tests/openai-chat-eof.test.ts tests/provider-registry-parity.test.ts
bun run typecheck
```

원본 PR은 draft이고 branch/label 체크만 있다. 축소 슬라이스도 전체 스위트를 새로 돌린다.
