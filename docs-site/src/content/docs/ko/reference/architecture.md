---
title: 아키텍처
description: opencodex 내부 구조 — 모듈 맵, AdapterEvent 브리지, 요청 파서, 그리고 캐싱.
---

opencodex는 단일 Bun 프로세스입니다. 요청은 OpenAI Responses로 들어와 내부 모델로 정규화되고,
라우팅된 뒤, 어댑터를 통해 프로바이더로 전송되고, 다시 Responses SSE로 브리징됩니다. 엔드투엔드
플로우는 [동작 원리](/opencodex/ko/getting-started/how-it-works/)를 참조하세요.

## 모듈 맵

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # base + openai-chat, openai-responses, anthropic, google, azure, image
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

## 파서

`responses/parser.ts`는 들어오는 요청을 `responses/schema.ts`(Zod)로 검증한 다음
`OcxParsedRequest`를 구성합니다:

- **Messages** — `input` 항목은 정규화된 `OcxMessage[]`가 됩니다: user / developer / assistant /
  toolResult. `reasoning` 항목은 thinking 블록이 되고, `function_call`, `custom_tool_call`,
  `tool_search_call` 항목은 툴 호출이 되며, 그에 대응하는 `*_output`은 툴 결과가 됩니다.
- **Tools** — function 툴은 그대로 통과합니다. **네임스페이스가 있는 (MCP) 툴은 평탄화되어**
  `namespace__name`이 됩니다(반환 시 복원됨). **freeform** 툴(예: `apply_patch`)과
  **tool_search** 디스커버리 툴은 플래그가 지정됩니다. **호스티드 툴**(`web_search`, image gen, …)은
  제거되며, 이를 처리할 사이드카가 있을 경우에만 다시 주입됩니다.
- **Images** — 실제 content 파트(data URL 또는 원격 https)로 보존되며, 절대 텍스트로 인라인되지
  않습니다.
- **Feature flags** — `_webSearch`(호스티드 웹 검색 요청됨)와 `_structuredOutput`(`text.format`이
  json_schema / json_object).

## 브리지

`bridge.ts`는 어댑터의 내부 `AdapterEvent` 스트림을 Codex가 이해하는 Responses SSE로 다시
변환합니다:

| AdapterEvent | Responses SSE emitted |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, item close |
| `tool_call_start` | `response.output_item.added` (type: `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (skipped for freeform / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `done` | `response.completed` (with usage) |
| `error` | `response.failed` (with `last_error`) |

브리지는 또한 **하트비트 킵얼라이브**(RC3)를 실행합니다: 업스트림 침묵 시, 2초마다 파서에서
무시되는 `response.heartbeat` SSE 이벤트를 내보내 Codex의 유휴 타이머를 재설정합니다. **스톨
데드라인** 150틱(기본 2초 간격에서 5분)이 경과하면 프로바이더가 재개하지 않을 경우 업스트림을
중단하고 스트림을 닫습니다 — Codex를 무기한 차단하는 행 커넥션을 방지합니다.

툴 호출은 파서가 캡처한 네임스페이스 맵, freeform 집합, tool-search 집합을 사용하여 세 가지
Responses 항목 타입으로 구분됩니다 — 따라서 MCP 네임스페이스, `apply_patch` 스타일의 freeform
툴, 클라이언트가 실행하는 `tool_search`가 모두 왕복합니다. `buildResponseJSON()` 변형은 동일한
이벤트로부터 단일 비스트리밍 응답 객체를 생성합니다.

## 전송과 compaction

`server/index.ts`는 기본적으로 `/v1/responses`를 HTTP/SSE로 제공합니다. `websockets`가 `false`인
상태에서 Codex가 Responses WebSocket 업그레이드를 시도하면 opencodex는 `426 upgrade_required`를
반환하고, Codex는 해당 세션에서 HTTP로 폴백합니다. `"websockets": true`가 설정되면 같은
엔드포인트가 업그레이드를 받아들이고 WebSocket 브리지를 사용합니다.

Codex 컨텍스트 compaction은 라우팅된 모델에서도 동작합니다. `server/responses.ts`는
`POST /v1/responses/compact`를 내부 라우팅 요약 턴으로 처리해 압축된 히스토리를 반환합니다.
`responses/parser.ts`와 `bridge.ts`는 remote compaction v2의 `compaction_trigger` 턴을 처리해
합성 `compaction` 출력 항목을 정확히 하나 내보냅니다.

## 캐싱과 카탈로그

- `codex/model-cache.ts`는 실시간 `/models` 결과를 프로바이더별로 메모리에 TTL 캐싱하며(기본 5분, Codex
  자체 캐시와 일치), fetch가 실패하면 stale-fallback을 제공합니다.
- `codex/catalog.ts`는 라우팅된 모델을 네임스페이스 항목으로 Codex의 카탈로그에 병합하고, 추천
  [서브에이전트 모델](/opencodex/ko/guides/codex-integration/#the-subagent-picker)을 먼저 랭크하며,
  `disabledModels`를 필터링하고, 일회성 백업으로부터 원본 카탈로그를 완전히 복원할 수 있습니다.

## Reasoning effort

`reasoning-effort.ts`는 Codex의 reasoning 레이블을 각 프로바이더의 와이어 값으로 변환합니다.
Codex 카탈로그는 Codex가 수용하는 레이블(`low` / `medium` / `high` / `xhigh`)만 광고하지만,
업스트림 프로바이더는 다른 이름(예: `max`)을 사용하거나 더 작은 하위 집합을 지원할 수 있습니다.
이 모듈은:

- 표준 `CODEX_REASONING_LEVELS`와 그 정렬 순서를 정의합니다.
- 요청된 effort를 정확한 레벨이 없을 때 가장 가까운 지원 단계로 클램핑합니다.
- 커스텀 와이어 매핑을 위한 모델별 및 프로바이더별 `reasoningEffortMap` 오버라이드를 해석합니다.
- `noReasoningModels`에 나열된 모델에 대해서는 effort를 완전히 제거합니다.

## 코어 타입

내부 모델은 `types.ts`에 있습니다: `OcxParsedRequest`, `OcxContext`, `OcxMessage` 유니온,
`OcxContentPart`(text / image), `OcxToolCall`, `OcxTool`, `AdapterEvent`, 그리고 설정 타입
(`OcxConfig`, `OcxProviderConfig`). 두 가지 헬퍼가 널리 사용됩니다: `namespacedToolName()`과
`modelInList()`(`noVisionModels` / `noReasoningModels`에 대한 관대한 `:size` 태그 매칭).
