# WP3 — PR #460 Kiro native stop reason + Opus 5 effort

대상: PR #460 (mushikingh), head `664934bf`. `git merge-tree` clean (tree `9ec2c446`).
인증/자격증명/OAuth/워크플로/릴리스 경계를 건드리지 않는다. 이 배치에서 유일하게
원본 의도 그대로 self-merge 가능한 provider PR이다.

## 결함 A — END_TURN 외 모든 stop reason이 추가 추론을 유발

PR head `src/adapters/kiro.ts:1005-1103`에서 `END_TURN`만 종료로 취급하고
`MAX_TOKENS`, `CONTENT_FILTERED`, `TOOL_USE`, 미래의 미지 값이 전부 `needsFallback: true`로
떨어진다. AWS는 이들을 서로 다른 종료 상태로 정의한다
(https://docs.aws.amazon.com/java/api/latest/software/amazon/awssdk/services/bedrockruntime/model/StopReason.html).
`MAX_TOKENS`에서 잘린 응답을 또 한 번 유료 요청으로 덮고, context window 초과에서는
dev에 이미 통합된 `fc517004`(context pressure)와 충돌해 과대 요청을 재전송할 수 있다.

INSERT — PR head `src/adapters/kiro.ts:1093-1099`의 `if (sawRealTool) { ... }` 블록 직후:

```ts
    if (mode === "required" && stopReason !== undefined) {
      const normalizedStopReason = stopReason.trim().toUpperCase();
      const incompleteReason =
        normalizedStopReason === "MAX_TOKENS"
          || normalizedStopReason === "MODEL_CONTEXT_WINDOW_EXCEEDED"
          ? "max_output_tokens"
          : normalizedStopReason === "CONTENT_FILTERED"
            || normalizedStopReason === "GUARDRAIL_INTERVENED"
            ? "content_filter"
            : `kiro_${normalizedStopReason.toLowerCase() || "unknown_stop"}`;

      return {
        assistantText,
        sawReasoning,
        terminal: {
          type: "incomplete",
          reason: incompleteReason,
          message: `Kiro stopped with ${normalizedStopReason || "an unknown reason"} before an explicit final answer`,
          usage: finalUsage,
          retryable:
            normalizedStopReason === "MAX_TOKENS"
            || normalizedStopReason === "MODEL_CONTEXT_WINDOW_EXCEEDED",
          endTurn: false,
          ...(finalProviderState ? { providerState: finalProviderState } : {}),
        },
      };
    }
```

선행 `completionAnswer` / `sawRealTool` 분기는 그대로 둔다. 실제 tool call을 동반한
정상 `TOOL_USE`는 계속 tool call을 내고, call 없는 모순된 `TOOL_USE`만 incomplete가 된다.

주석 교체 — before:

```ts
// Kiro text has no trustworthy final/progress marker. When completion is required, ordinary
// text and reasoning remain unfinished until the one bounded fallback validates the turn.
```

after:

```ts
// Only a missing native stop reason uses the compatibility fallback. Any explicit reason has
// already terminated this inference and must not be converted into another model request.
```

## 결함 B — fuzzy restatement 억제가 진짜 최종 상태를 삭제

`src/adapters/kiro-restatement.ts:28-77`의 LCS 임계값(첫 400단어 중 65% 공유, 20% 이내 증가,
11단어 이하 차이 구간)은 "I will update / run / verify" → "I updated / ran / verified" 같은
상태 전환을 중복으로 분류한다. 긴 응답에서 한 단어 시제 변화가 결과를 뒤집는데 억제된다.

DO NOT INTEGRATE: `src/adapters/kiro-restatement.ts`, `tests/kiro-restatement.test.ts`.

`src/adapters/kiro.ts`에서 import 제거:

```ts
import { isKiroRestatement } from "./kiro-restatement";
```

dev 기준 정확 비교를 유지한다:

```ts
function normalizedKiroAnswer(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isRepeatedKiroAnswer(text: string, previous?: string): boolean {
  return normalizedKiroAnswer(text) === normalizedKiroAnswer(previous ?? "");
}
```

## 회귀 테스트 1 — stop reason

REPLACE: PR head의 `"a non-END_TURN stop reason still requires the bounded completion fallback"`
테스트를 아래로 교체 (`tests/kiro-stream.test.ts`).

```ts
test("MAX_TOKENS terminates as incomplete without a bounded completion request", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(streamOf(...completionFrames("must not run")));
  }) as typeof fetch;

  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(
    parsedWith([{ role: "user", content: "write a long report" }], [bashTool]),
  );

  const events = await collectAdapterEvents(
    adapter.parseStream(
      new Response(
        streamOf(
          eventFrame({ content: "Partial report." }),
          eventFrame({ stopReason: "MAX_TOKENS" }, "metadataEvent"),
        ),
      ),
    ),
  );

  expect(fetches).toBe(0);
  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Partial report.", phase: "commentary" },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "incomplete",
    reason: "max_output_tokens",
    retryable: true,
    endTurn: false,
  });
});
```

RED→GREEN 근거: PR head에서는 `fetches`가 1이 되고 terminal이 `done`이라 두 assertion이
모두 실패한다. 수정 후에는 `parseKiroStream()`이 `fallbackFactory`를 부르기 전에 반환한다.

## 회귀 테스트 2 — restatement 보존

APPEND: `tests/kiro-stream.test.ts`

```ts
test("bounded fallback preserves a final status update that mostly repeats commentary", async () => {
  const progress =
    "I checked the repository, read the provider implementation, inspected the related tests, "
    + "ran the focused validation commands, and reviewed the generated diagnostics. The migration "
    + "is still pending because the final verification job has not completed, so the branch must "
    + "not be reported as ready yet.";

  const finalStatus =
    "I checked the repository, read the provider implementation, inspected the related tests, "
    + "ran the focused validation commands, and reviewed the generated diagnostics. The migration "
    + "is now complete because the final verification job has completed, so the branch can "
    + "be reported as ready.";

  globalThis.fetch = (async () =>
    new Response(streamOf(eventFrame({ content: finalStatus })))) as typeof fetch;

  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(
    parsedWith([{ role: "user", content: "finish the migration" }], [bashTool]),
  );

  const events = await collectAdapterEvents(
    adapter.parseStream(new Response(streamOf(eventFrame({ content: progress })))),
  );

  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: progress, phase: "commentary" },
    { type: "text_delta", text: finalStatus, phase: "final_answer" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
});
```

RED→GREEN 근거: PR head는 두 텍스트가 40단어 초과·65% 훨씬 상회·짧은 삽입 구간이라
`finalStatus`를 억제해 `text_delta`가 1개만 남는다.

## 문서

`docs-site/src/content/docs/reference/adapters.md`의 completion 문단을 아래로 교체한다.
PR head의 "END_TURN 아닌 것은 전부 fallback" 서술은 결함 A 수정 후 거짓이 된다.

```md
Kiro assistant text carries no dependable end-turn phase of its own. Its terminal `metadataEvent`
can, however, carry a native `stopReason`. An `END_TURN` response holding plain assistant text with
no client tool call ends the turn directly, with that text emitted as the final answer and no extra
model round trip.

Only a missing stop reason uses the compatibility completion path. Other explicit stop reasons
terminate the current inference without another model request: `TOOL_USE` must accompany a real
tool call, token/context limits surface as incomplete output, and filtering or guardrail stops
surface as filtered incomplete output.

When no native stop reason is present and an ordinary client tool is available, opencodex adds a
private `codex_kiro_final_answer` tool. If Kiro emits progress without calling it, the adapter makes
one bounded continuation. Duplicate suppression is deliberately limited to whitespace-normalized
exact repeats; a reworded status update is retained because suppressing genuine final information
is worse than displaying a cosmetic restatement.
```

같은 completion 의미와 Opus 5 `output_config.effort` 문단을 아래 4개 로케일에 반영한다.
현재 이 파일들은 Kiro 전송 계층 불릿에서 끝나고 completion/effort 서술이 아예 없다.

```
docs-site/src/content/docs/ja/reference/adapters.md
docs-site/src/content/docs/ko/reference/adapters.md
docs-site/src/content/docs/ru/reference/adapters.md
docs-site/src/content/docs/zh-cn/reference/adapters.md
```

Opus 5의 effort 값(`low`/`medium`/`high`/`xhigh`/`max`)은 Kiro 공식 문서로 확인됨
(https://kiro.dev/docs/cli/chat/effort/).

## 활성화 시나리오

새 분기는 `mode === "required" && stopReason !== undefined` 게이트와 그 안의 3갈래
`incompleteReason` 매핑이다. 테스트 1이 `MAX_TOKENS` 경로를 밟아 `fetches === 0`과
`reason === "max_output_tokens"`로 활성화를 증명한다. 관찰 효과는 추가 fetch 부재다.

## 커밋

```
fix(kiro): honor native stop reasons and Opus 5 effort (#460)

Co-authored-by: Mushikingh <164845020+mushikingh@users.noreply.github.com>
```

## 검증

```bash
bun test --isolate tests/kiro-adapter.test.ts tests/kiro-stream.test.ts
bun run typecheck
```

PR head의 Ubuntu CI는 `4240 pass / 1 fail`인데, 실패는 무관한
`combo management API > PUT renames atomically...` 타임아웃이다. 통합 head에서 전체 재확인한다.
