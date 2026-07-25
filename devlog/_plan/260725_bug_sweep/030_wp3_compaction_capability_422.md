# WP3 — #422 API-key openai-responses에서 remote compaction v2 fatal

## 증상

`authMode: "key"`인 `openai-responses` provider로 라우팅할 때 Codex의 remote compaction v2가
fatal로 끝난다. 프록시 관점에서는 HTTP 200이지만 Codex가 요구하는 `compaction` item이 0개다.

```
Error running remote compact task: Fatal error:
remote compaction v2 expected exactly one compaction output item,
got 0 from N output items
```

fatal 지점은 upstream Codex의 `collect_compaction_output()`이다.
([compact_remote_v2.rs:380-423](https://github.com/openai/codex/blob/4c43465133428898aa84f0bfc02c306ed65fb66a/codex-rs/core/src/compact_remote_v2.rs#L380-L423))

## 이슈 본문 전제 정정

이슈는 "표준 OpenAI API가 compaction을 미지원"한다고 적었지만 현재 기준으로 틀렸다.
공식 Responses API는 `context_management`와 `POST /responses/compact`를 지원한다.
([Compaction guide](https://developers.openai.com/api/docs/guides/compaction),
[compact API reference](https://developers.openai.com/api/reference/resources/responses/methods/compact))

공개 API에 없는 것은 `/responses` **입력**의 `compaction_trigger` item이다. 따라서 정확한
근거는 "표준 compaction 미지원"이 아니라 **"Responses wire를 지원한다는 사실만으로 Codex v2
trigger 지원을 추론할 수 없다"** 이다. 이 구분이 수정 설계를 가른다.

## 근본 원인

`openai-responses`라는 **wire format**을 `compaction_trigger`를 처리할 수 있는
**capability**로 잘못 간주한다. `authMode`는 정상적으로 결정·보존되지만, compaction 실행을
정하는 분기 두 곳이 그걸 보지 않는다.

### 실패 경로

1. `src/responses/parser.ts:254` — trigger를 normalized 메시지에서 제거하고 플래그만 세운다.
   그러나 원본은 `_rawBody`에 그대로 남는다.

```ts
if (effectiveType === "compaction_trigger") {
  compactionRequest = true;
  continue;
}
...
_rawBody: body,
...(compactionRequest ? { _compactionRequest: true } : {}),
```

2. `src/server/adapter-resolve.ts:27` — 모든 `openai-responses`가 passthrough adapter가 된다.
   `authMode`를 보지 않는다.

3. `src/server/responses/core.ts:973` — passthrough이므로 synthetic compaction이 꺼진다.

```ts
const routedCompaction =
  parsed._compactionRequest === true
  && !("passthrough" in adapter && adapter.passthrough);
```

`routedCompaction === false` → `COMPACT_PROMPT` 미삽입, tools 미제거, passthrough 분기 진입.

4. `src/adapters/openai-responses.ts:550` — raw body가 그대로 upstream으로 간다.
   `compaction_trigger`를 제거하는 sanitizer가 없고, parser는 의도적으로 stub이다.

```ts
async *parseStream(): AsyncGenerator<AdapterEvent> {
  yield { type: "error", message: "passthrough adapter should not parse stream" };
}
```

따라서 `routedCompaction` 플래그만 뒤집는 수정은 불충분하다. 실행 분기와 응답 parsing까지
같이 바꿔야 한다.

5. `src/server/responses/core.ts:1182` — 성공 SSE를 compaction item 확인 없이 relay한다.

### v1에도 같은 계열 결함

`src/server/responses/compact.ts:205`는 adapter 이름만 보고 native endpoint를 호출한다.

```ts
if (route.provider.adapter === "openai-responses") {
  ...
  const compactUrl = `${base}/responses/compact`;
```

`/responses/compact`를 지원하지 않는 호환 게이트웨이도 native로 오분류된다.

## 수정 방향

capability를 adapter 이름에서 분리한다. 대안 비교:

| 안 | 판단 |
|---|---|
| 1. authMode 기반 capability gate + non-forward synthetic | **채택** — trigger를 미지원 upstream에 보내지 않고 기존 envelope·bridge 재사용 |
| 2. 명시적 capability config 추가 | 정확하지만 public config/type/registry/docs까지 범위 확대. 장기 과제 |
| 3. 응답에 compaction item 없으면 사후 wrapping | 이미 private trigger/tools를 보낸 뒤. SSE 전체 버퍼링 필요 |
| 4. 명확한 proxy 오류만 반환 | fatal은 피하지만 compaction은 여전히 실패 |

공식 `openai-apikey`의 `/responses/compact` 지원은 반드시 보존한다.

- `authMode: "forward"` → v2 trigger native passthrough
- 공식 `openai-apikey` → v1 `/responses/compact` native 유지
- custom API-key `openai-responses` → v1/v2 모두 synthetic summarizer

## Diff-level 변경안

### `src/providers/openai-tiers.ts`

두 capability를 분리한다. 공식 OpenAI API-key는 `/responses/compact`는 지원하지만
공개 `compaction_trigger` 계약은 제공하지 않으므로 하나로 묶을 수 없다.

```ts
+/** Can this provider accept a Codex v2 `compaction_trigger` input item? */
+export function supportsNativeResponsesCompactionTrigger(provider: OcxProviderConfig): boolean {
+  return provider.adapter === "openai-responses" && provider.authMode === "forward";
+}
+
+/** Can this provider serve `POST /responses/compact`? */
+export function supportsNativeResponsesCompactEndpoint(
+  providerName: string,
+  provider: OcxProviderConfig,
+): boolean {
+  return provider.adapter === "openai-responses"
+    && (
+      provider.authMode === "forward"
+      || (providerName === OPENAI_API_PROVIDER_ID
+        && normalizedBaseUrl(provider.baseUrl) === "https://api.openai.com/v1")
+    );
+}
```

### `src/server/responses/compact.ts` (205행)

```ts
-if (route.provider.adapter === "openai-responses") {
+if (supportsNativeResponsesCompactEndpoint(route.providerName, route.provider)) {
```

나머지 custom key provider는 기존 305-339행 synthetic 경로로 내려간다.

### `src/server/responses/core.ts` (973행)

```ts
-const routedCompaction =
-  parsed._compactionRequest === true
-  && !("passthrough" in adapter && adapter.passthrough);
+// A Responses-shaped wire does not imply Codex v2 trigger support: only the
+// forward (ChatGPT) path speaks that contract (#422).
+const routedCompaction =
+  parsed._compactionRequest === true
+  && !supportsNativeResponsesCompactionTrigger(route.provider);
 ...
-if ("passthrough" in adapter && adapter.passthrough) {
+if (isPassthrough && !routedCompaction) {
```

### `src/adapters/openai-responses.ts`

key-mode에서 trigger를 제거하고 요약 프롬프트로 대체한다.

```ts
+function buildSyntheticCompactionBody(body: unknown): unknown {
+  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
+  const { tools: _t, tool_choice: _tc, parallel_tool_calls: _p, ...rest } = body;
+  return {
+    ...rest,
+    input: [
+      ...body.input.filter(item => !isPlainObject(item) || item.type !== "compaction_trigger"),
+      { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] },
+    ],
+  };
+}
```

`buildRequest()` 중간:

```ts
+if (!forward && parsed._compactionRequest === true) {
+  outBody = buildSyntheticCompactionBody(outBody);
+}
```

stub parser 교체 — `src/lib/sse-decoder.ts`를 재사용해 다음만 변환하면 된다.

```
response.output_text.delta -> { type: "text_delta", text }
response.completed         -> { type: "done" }
response.failed / error    -> { type: "error", message }
```

non-streaming JSON은 `output[].type === "message"`의 `output_text`를 합쳐
`text_delta + done`으로 변환한다. 이후 `src/bridge.ts:652`의 기존 로직이 정확히 하나의
`compaction` item으로 감싼다.

## 회귀 테스트

새 파일 `tests/responses-compaction-routing.test.ts`.
`tests/responses-shadow-intercept.test.ts:66`의 `globalThis.fetch` + `handleResponses()`
패턴을 따른다 (기존 `responses-compaction.test.ts`는 helper 단위 테스트 중심이라 부적합).

1. `key openai-responses + compaction_trigger + stream:true`
   - upstream body에 `compaction_trigger` 없음, tools 없음, `COMPACT_PROMPT` 포함
   - proxy SSE의 `response.output_item.done`이 정확히 1개이고 type이 `compaction`
   - 수정 전 실패: trigger가 그대로 전달되고 결과가 `message`

2. 같은 조건 `stream:false`
   - JSON `output`이 `compaction` 1개

3. `forward openai-responses` 보존
   - trigger가 ChatGPT upstream으로 전달되고 encrypted `compaction` item이 무변경 relay
   - capability gate가 forward를 synthetic으로 오분류하지 않음을 고정

4. custom key provider의 `POST /v1/responses/compact`
   - `/responses/compact`가 아니라 synthetic `/responses` 호출
   - 수정 전 실패: 무조건 `/responses/compact`

5. built-in `openai-apikey`의 v1 보존
   - 공식 `/v1/responses/compact`를 계속 호출

## 기준선

```
bun test tests/responses-compaction.test.ts tests/openai-responses-passthrough.test.ts
46 pass / 0 fail
```

## 검증 명령

```bash
bun test tests/responses-compaction-routing.test.ts tests/responses-compaction.test.ts \
         tests/openai-responses-passthrough.test.ts
bun run typecheck
```
