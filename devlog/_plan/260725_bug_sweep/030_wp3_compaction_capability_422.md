# WP3 — #422 API-key openai-responses에서 remote compaction v2 fatal

> 개정 이력: r1 초안은 A-gate에서 FAIL. blocker 4(non-stream 경로가 `parseResponse`
> 부재로 400을 내는데 diff가 `parseStream`만 다룸)를 r2에서 수정했다. 외부 근거와
> 이슈 본문 전제 정정은 `001_external_evidence.md` 참조.

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

이슈의 "표준 OpenAI API는 compaction 미지원" 주장은 틀렸다. 정확한 근거는
**"Responses wire를 지원한다는 사실만으로 Codex v2 trigger 지원을 추론할 수 없다"** 이다.
상세 출처는 `001_external_evidence.md` §OpenAI Compaction 참조.

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

capability를 adapter 이름에서 분리한다. authMode 기반 gate + non-forward synthetic을
채택한다 (대안 비교는 조사 단계에서 수행: 사후 wrapping은 이미 private trigger를 보낸
뒤라 늦고, proxy 오류 반환은 compaction 자체를 포기한다).

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

**stub parser 교체 — 두 메서드 모두 필요하다.**

r1은 `parseStream`만 다뤘으나, non-stream 경로는 `adapter.parseResponse`가 없으면
`src/server/responses/core.ts:1828`에서 끝난다.

```ts
  return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
```

`/responses/compact`의 synthetic 내부 요청도 `stream:false`를 강제하므로 같은 400을 맞는다.
따라서 두 메서드를 함께 구현한다.

```ts
+async *parseSyntheticCompactionStream(response: Response): AsyncGenerator<AdapterEvent> {
+  for await (const event of decodeSse(response)) {
+    const data = safeJsonParse(event.data);
+    if (!isPlainObject(data)) continue;
+    switch (data.type) {
+      case "response.output_text.delta":
+        if (typeof data.delta === "string") yield { type: "text_delta", text: data.delta };
+        break;
+      case "response.failed":
+      case "error":
+        yield { type: "error", message: errorMessageOf(data) };
+        return;
+      case "response.completed":
+        yield { type: "done", usage: usageFromResponsesPayload(data.response) };
+        return;
+    }
+  }
+  yield { type: "done" };
+}
+
+/**
+ * Non-stream sibling. Without this the generic non-stream path fails with
+ * "Non-streaming not supported by this adapter" (core.ts:1828), which also
+ * breaks the v1 /responses/compact synthetic path since it forces stream:false.
+ */
+async parseResponse(response: Response): Promise<AdapterEvent[]> {
+  const json = await response.json();
+  if (!isPlainObject(json)) return [{ type: "error", message: "malformed compaction response" }];
+  if (json.error) return [{ type: "error", message: errorMessageOf(json) }];
+  const text = Array.isArray(json.output)
+    ? json.output
+        .filter(item => isPlainObject(item) && item.type === "message")
+        .flatMap(item => Array.isArray(item.content) ? item.content : [])
+        .filter(part => isPlainObject(part) && part.type === "output_text")
+        .map(part => String(part.text ?? ""))
+        .join("")
+    : "";
+  return [
+    ...(text ? [{ type: "text_delta" as const, text }] : []),
+    { type: "done" as const, usage: usageFromResponsesPayload(json) },
+  ];
+}
```

`usageFromResponsesPayload()`는 이 어댑터가 일반 경로에서 이미 쓰는 usage 추출 로직을
재사용한다. B 단계에서 실제 export 이름을 확인해 맞춘다.

이후 `src/bridge.ts:652`의 기존 로직이 정확히 하나의 `compaction` item으로 감싼다.

## 회귀 테스트

새 파일 `tests/responses-compaction-routing.test.ts`.
`tests/responses-shadow-intercept.test.ts:66`의 `globalThis.fetch` + `handleResponses()`
패턴을 따른다 (기존 `responses-compaction.test.ts`는 helper 단위 테스트 중심이라 부적합).

1. `key openai-responses + compaction_trigger + stream:true`
   - upstream body에 `compaction_trigger` 없음, tools 없음, `COMPACT_PROMPT` 포함
   - proxy SSE의 `response.output_item.done`이 정확히 1개이고 type이 `compaction`
   - 수정 전 실패: trigger가 그대로 전달되고 결과가 `message`

2. 같은 조건 `stream:false` — **blocker 4 회귀**
   - JSON `output`이 `compaction` 1개
   - 수정 전 실패: `parseResponse` 부재로 400 "Non-streaming not supported by this adapter"

3. `forward openai-responses` 보존
   - trigger가 ChatGPT upstream으로 전달되고 encrypted `compaction` item이 무변경 relay
   - capability gate가 forward를 synthetic으로 오분류하지 않음을 고정

4. custom key provider의 `POST /v1/responses/compact` — **blocker 4 회귀**
   - `/responses/compact`가 아니라 synthetic `/responses` 호출
   - 내부 요청이 `stream:false`이므로 `parseResponse`가 반드시 동작해야 함
   - 최종 v1 output이 retained user message + `SUMMARY_PREFIX` summary
   - 수정 전 실패: 무조건 `/responses/compact`

6. `upstream error surfaces as an error, not an empty compaction`
   - stream/non-stream 각각에서 upstream이 `response.failed` 또는 `{error}`를 줄 때
     빈 `compaction` item을 만들지 않고 오류로 전달

## WP5와의 공유 지점

`src/server/responses/core.ts`와 `src/server/responses/compact.ts`를 WP5도 수정한다.
WP3를 먼저 닫고, WP5의 P에서 이 결과 위에 stale 체크를 수행한다.

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
