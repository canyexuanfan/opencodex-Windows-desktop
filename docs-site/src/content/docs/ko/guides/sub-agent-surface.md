---
title: 서브에이전트 서피스 (v1 / base / v2)
description: 모든 모델의 Codex 서브에이전트 생성·관리 방식을 전역으로 제어합니다.
---

opencodex에서는 카탈로그의 모든 모델이 사용할 멀티에이전트 협업 서피스를 선택할 수 있습니다. 대시보드와 모델 페이지의 **서브에이전트** 토글이 이 값을 전역으로 제어합니다.

:::caution
**v2 서피스(`multi_agent_v2`)에서 생성된 서브에이전트는 항상 부모 세션의 모델을 그대로 상속합니다. `spawn_agent`의 모델 오버라이드는 적용되지 않으므로 v2에서는 다른 모델로 서브에이전트를 띄울 수 없습니다. 교차 모델 스폰은 v1 서피스에서만 가능합니다.**
:::

## 모드

| 모드 | 서피스 | 동작 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 네임스페이스 방식의 클래식 에이전트 툴과 `send_input` / `close_agent` / `resume_agent`를 사용합니다. `spawn_agent` 모델 오버라이드로 다른 모델의 서브에이전트를 띄울 수 있습니다. |
| **base** (기본값) | 업스트림 핀 | 업스트림 모델 핀을 복원합니다. gpt-5.6-sol과 gpt-5.6-terra는 v2, gpt-5.6-luna는 v1을 쓰고, 핀이 없는 모델은 Codex `multi_agent_v2` 기능 플래그를 따릅니다. 실제 스폰 동작은 각 모델에 결정된 서피스를 따릅니다. |
| **v2** | `multi_agent_v2` | 플랫 `spawn_agent` 툴과 동시 세션, `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`를 사용합니다. 모든 자식 에이전트가 부모 모델을 상속하며 모델 오버라이드는 무시됩니다. |

## 동작 방식

선택한 모드는 Codex가 읽는 모든 카탈로그 항목의 `multi_agent_version` 필드를 설정합니다.

- **v1 모드**: 모든 항목에 `multi_agent_version = "v1"`을 강제해 업스트림 핀을 덮어씁니다.
- **base 모드**: 업스트림 기본값을 복원합니다. 핀이 있는 모델은 스냅샷 값을 쓰고, 핀이 없는 모델은 필드를 제거해 Codex 기능 플래그가 결정하게 합니다.
- **v2 모드**: 모든 항목에 `multi_agent_version = "v2"`를 강제해 업스트림 핀을 덮어씁니다.

이 오버라이드는 라이브 `/v1/models` 카탈로그 응답과 디스크 카탈로그 동기화 양쪽에서 마지막 패스로 실행됩니다. 따라서 항목이 어떤 경로로 만들어졌든 새 세션부터 같은 모드가 적용됩니다.

### 위임 모델과 추론 강도

대시보드의 **서브에이전트 위임** 선택기는 `injectionModel`과 선택 사항인 `injectionEffort`를 저장합니다. 이 값은 위임 가이드를 만드는 설정이지, 프록시가 스폰 요청을 다른 모델로 다시 라우팅하는 설정이 아닙니다.

`multiAgentGuidanceText`는 요청에 들어온 툴 목록으로 서피스를 판별합니다. **v1** 요청에서는 주입 모델을 지정하면 부모의 추론 강도와 관계없이 프록시가 능동 위임 가이드를 추가합니다. 가이드에는 `spawn_agent`에 넘길 정확한 모델 이름이 들어가며, 추론 강도까지 지정했다면 정확한 `reasoning_effort`도 함께 들어갑니다. 주입 모델 없이 추론 강도만 지정하면 아무 효과가 없습니다.

**v2**에서는 Codex가 자체 능동 위임 가이드를 제공하므로 opencodex 헬퍼가 v1 호환 메시지를 주입하지 않고 바로 종료합니다. 따라서 현재 프록시는 v2 요청에 `injectionModel`이나 `injectionEffort`를 덧붙이지 않습니다. v2 위임 가이드에 이런 선호값이 표시되더라도 안내일 뿐입니다. 스폰마다 교차 모델 요청을 만들거나 프록시가 모델을 바꿔 쓰는 경로는 없으며, 자식은 여전히 부모 세션의 모델로 실행됩니다. 다만 v2의 `spawn_agent`에 실제로 전달된 `reasoning_effort`는 적용할 수 있으며, 이 추론 강도는 모델 상속 규칙과 별개입니다.

## 모드 변경

### GUI

- **대시보드** → 첫 번째 스탯 셀에서 **v1**, **base**, **v2**를 선택합니다.
- **모델** 페이지 → 상단 세그먼트 컨트롤에서 선택합니다.
- 두 페이지 모두 **?** 버튼을 누르면 이 문서로 연결되는 도움말 모달이 열립니다.
- **대시보드** → **서브에이전트 위임**에서 선호 모델과 선택 사항인 추론 강도를 고릅니다. v2에서는 모델 선택이 가이드용일 뿐 상속 규칙을 덮어쓸 수 없습니다.

### CLI

```bash
ocx v2 mode v1       # 모든 모델을 v1으로 강제
ocx v2 mode default  # 업스트림 핀 복원
ocx v2 mode v2       # 모든 모델을 v2로 강제
ocx v2 status        # 현재 모드 + Codex 기능 플래그 확인
```

### API

```bash
# 서피스 모드, 기능 플래그, 스레드 제한 조회
curl http://localhost:10100/api/v2

# 서피스 모드 설정
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` PUT 엔드포인트는 `enabled`(불리언, Codex 기능 플래그)와 `maxConcurrentThreadsPerSession`(정수)도 받습니다. 요청을 검증하고 모드를 저장한 뒤 카탈로그를 다시 동기화하며, 변경 사항은 새 세션부터 적용됩니다.

위임 선택기는 별도 엔드포인트를 사용합니다.

```bash
# 현재 모델/추론 강도와 선택 가능한 값 조회
curl http://localhost:10100/api/injection-model

# 두 값 설정
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# 두 값 모두 해제
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model`은 `model`, `effort`, 전역 `efforts` 단계, 활성화된 네이티브·라우팅 모델인 `available`을 반환합니다. PUT에서 `effort`를 생략하면 기존 값을 유지하고, `null`이면 지웁니다. `model`을 지우면 추론 강도도 항상 함께 지워집니다. API는 전역 Codex 단계에 맞는 추론 강도인지 검증하고, Codex는 스폰 시 대상 카탈로그 항목이 그 강도를 지원하는지 다시 검증합니다.

## 추론 강도

서브에이전트 추론 강도는 `injectionEffort`에 저장되며 주입 모델이 있을 때만 의미가 있습니다. 현재 프록시 경로에서는 v1 위임 가이드에 `reasoning_effort` 지시를 추가하며, 부모 세션의 추론 강도를 바꾸지는 않습니다. 이와 별개로 v2는 부모 모델을 상속하면서도 `spawn_agent`에 전달된 `reasoning_effort`를 적용할 수 있습니다.

`ultra`는 Codex 카탈로그에서 `max`보다 높은 단계이며 자동 위임 의미가 더해지지만, 프로바이더 와이어에는 `ultra`라는 값이 그대로 전달되지 않습니다. Codex가 클라이언트 경계에서 `ultra`를 `max`로 바꾸고, opencodex가 프로바이더에 맞는 유효한 값으로 조정합니다.

| 모델 | 와이어의 `max` | `ultra` 선택 시 와이어 값 |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh (max 변환 후 `nativeEffortClamp`) |
| gpt-5.6-sol, gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 정확한 업스트림 단계에 노출되지 않음 |
| 라우팅 모델 | 어댑터가 매핑하거나 클램프 | max로 변환한 뒤 어댑터가 매핑하거나 클램프 |

카탈로그에 어떤 추론 강도를 노출할지는 v1/v2 모드와 무관합니다. 추론 가능한 생성 항목에는 직접 지정한 서브에이전트 강도가 검증을 통과하도록 `max`가 들어가며, 현재 생성되는 라우팅 항목에는 `ultra`도 들어갑니다. 다만 정확한 업스트림 모델 단계는 그대로 보존하므로 gpt-5.6-luna는 `max`에서 끝납니다.

## 컨텍스트 상한

전역 컨텍스트 상한 값의 기본값은 350k입니다. 상한을 켠 라우팅 프로바이더의 `context_window`만 제한하며, 네이티브 OpenAI 모델은 실제 컨텍스트 윈도우를 그대로 사용합니다.

모델 페이지에서 값이나 전체 프로바이더 설정을 바꾸거나, 각 프로바이더 그룹 헤더 옆에서 상한을 개별적으로 켜고 끌 수 있습니다.
