---
title: 서브에이전트 서피스 (v1 / base / v2)
description: 모든 모델의 Codex 서브에이전트 생성·관리 방식을 전역으로 제어합니다.
---

opencodex는 카탈로그의 모든 모델이 쓸 멀티에이전트 협업 서피스를 직접 고를 수 있게 해줍니다. 대시보드와 모델 페이지의 **서브에이전트** 토글이 이 값을 전역으로 제어합니다.

## 모드

| 모드 | 서피스 | 동작 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 클래식 단일 스레드 에이전트. 세션당 모델 하나, 순차 툴 호출. `send_input` / `close_agent` / `resume_agent` 동사 사용. |
| **base** (기본값) | 업스트림 핀 | 업스트림 모델 핀을 그대로 따릅니다: gpt-5.6-sol과 gpt-5.6-terra는 v2, gpt-5.6-luna는 v1, 나머지는 Codex `multi_agent_v2` 기능 플래그를 따릅니다. |
| **v2** | `multi_agent_v2` | `spawn_agent`를 쓰는 멀티 스레드 에이전트. 병렬 툴 호출, 동시 세션, `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` 동사 사용. |

## 동작 방식

선택한 모드는 Codex가 읽는 모든 카탈로그 항목의 `multi_agent_version` 필드를 설정합니다:

- **v1 모드**: 모든 항목에 `multi_agent_version = "v1"`을 강제하고 업스트림 핀을 덮어씁니다.
- **base 모드**: 업스트림 기본값을 복원합니다 — 핀이 있는 모델은 스냅샷 값을, 없는 모델은 `null`을 받습니다(Codex 기능 플래그가 결정).
- **v2 모드**: 모든 항목에 `multi_agent_version = "v2"`를 강제하고 업스트림 핀을 덮어씁니다.

이 오버라이드는 라이브 `/v1/models` 엔드포인트와 디스크 카탈로그 동기화 양쪽에서 마지막 패스로 실행되므로, 항목이 어떻게 만들어졌든 항상 적용됩니다.

## 모드 변경

### GUI

- **대시보드** → 첫 번째 스탯 셀에서 **v1**, **base**, **v2** 클릭.
- **모델** 페이지 → 상단 세그먼트 컨트롤.
- 두 페이지 모두 **?** 버튼을 누르면 이 문서로 연결되는 도움말 모달이 열립니다.

### CLI

```bash
ocx v2 mode v1      # 모든 모델을 v1으로 강제
ocx v2 mode default  # 업스트림 핀 복원
ocx v2 mode v2      # 모든 모델을 v2로 강제
ocx v2 status       # 현재 모드 + codex 기능 플래그 확인
```

### API

```bash
# 조회
curl http://localhost:10100/api/v2

# 설정
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

같은 PUT 본문에 `enabled`(불리언, Codex 기능 플래그)와 `maxConcurrentThreadsPerSession`(정수)도 넣을 수 있습니다.

## 추론 강도

**ultra** 추론 레벨은 v2 토글과 무관하게 카탈로그에 항상 노출됩니다. 와이어 클램프(`nativeEffortClamp`)가 ultra를 각 모델의 실제 최고 단계로 변환해 전송합니다:

| 모델 | 와이어의 ultra | 와이어의 max |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh |
| gpt-5.6-sol, gpt-5.6-terra | ultra (네이티브) | max (네이티브) |
| gpt-5.6-luna | max (네이티브 ultra 없음) | max |
| 라우팅 모델 | 어댑터가 매핑 | 어댑터가 매핑 |

`max`는 추론 가능한 모든 항목에 항상 존재하므로, `reasoning_effort: "max"`로 스폰한 서브에이전트는 언제나 카탈로그 검증을 통과합니다.

## 컨텍스트 상한

전역 컨텍스트 상한(기본 350k)은 라우팅된 프로바이더 모델이 광고하는 `context_window`를 제한합니다. 네이티브 OpenAI 모델은 실제 컨텍스트 윈도우를 쓰며 이 상한의 영향을 받지 않습니다.

모델 페이지 드롭다운에서 상한을 바꾸거나, 프로바이더 그룹 헤더 옆 토글로 프로바이더별로 조정할 수 있습니다.
