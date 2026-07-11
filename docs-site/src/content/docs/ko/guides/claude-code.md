---
title: Claude Code
description: Claude Code에서 라우팅된 모든 모델 사용하기 — opencodex가 같은 포트에서 Anthropic Messages API와 게이트웨이 모델 디스커버리를 제공합니다.
---

opencodex는 `/v1/responses`와 나란히 `POST /v1/messages`(+ `count_tokens`)를 제공합니다. Claude
Code가 모든 라우팅 프로바이더를 그대로 사용할 수 있고 — OAuth 로그인, 계정 풀, 키 페일오버,
사이드카 포함 — 추가 인증 작업은 없습니다.

## 빠른 시작

```bash
ocx claude
```

`ocx claude`는 프록시 실행을 보장한 뒤, 환경변수를 주입해 Claude Code를 실행합니다:

| 변수 | 값 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | 프록시가 API 키를 요구할 때만 — 그 외에는 설정하지 않아 claude.ai 로그인(구독 + 커넥터)이 유지됩니다 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (네이티브 `/model` 피커 디스커버리) |
| `ANTHROPIC_MODEL` | `claudeCode.model` (선택) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.smallFastModel` (선택, 레거시 `ANTHROPIC_SMALL_FAST_MODEL` 포함) |

직접 export한 변수가 항상 우선합니다. 추가 인자는 그대로 전달됩니다: `ocx claude -p "hello"`.

## 네이티브 Claude 패스스루 (구독 관통)

인증 오버라이드가 없으면 Claude Code는 claude.ai OAuth 로그인을 유지한 채 프록시로 보냅니다.
별칭이나 모델 매핑에 걸리지 않는 진짜 `claude*`/`anthropic*` 모델 요청은 사용자 자신의 자격
증명과 모든 end-to-end 헤더 그대로 `api.anthropic.com`에 **verbatim** 포워딩됩니다 — 베타,
thinking 서명, 프롬프트 캐싱, 과금 정체성이 전부 네이티브로 유지되고, 같은 세션에서 피커
별칭으로 라우팅 모델도 함께 사용할 수 있습니다. 이 덕분에 `ocx claude`에서
"claude.ai connectors are disabled" 경고도 더 이상 뜨지 않습니다.
끄려면 `claudeCode.nativePassthrough: false`, 대상 변경은 `claudeCode.anthropicBaseUrl`.

## /model 피커 ("From gateway")

Claude Code 2.1.129+는 게이트웨이 모델을 디스커버리합니다: `GET /v1/models?limit=1000`을 호출해
네이티브 `/model` 피커에 "From gateway" 라벨로 표시합니다. 피커는 `claude` 또는 `anthropic`으로
시작하는 id만 받아들이므로, opencodex는 라우팅 모델을 안정적이고 가역적인 별칭으로 노출합니다:

```
claude-ocx-<provider>--<model>     예: claude-ocx-gemini--gemini-3-pro
claude-ocx-native--<slug>          예: claude-ocx-native--gpt-5.5   (네이티브 OpenAI 모델)
```

각 항목은 `gemini-3-pro (gemini)` 같은 정직한 표시 이름을 가집니다. 선택하면 Claude Code의
`settings.json` `model` 필드에 저장되고, 인바운드 요청에서 별칭이 라우팅 모델로 되돌려집니다.
구버전 Claude Code에서는 `ANTHROPIC_MODEL`로 슬롯을 지정하거나 `/model`에 라우팅 id를 직접
입력하세요 (Claude Code는 문자열을 그대로 통과시킵니다).

## GUI

대시보드에 전용 **Claude** 페이지가 있습니다 (사이드바에서 API 아래): 인바운드 킬 스위치,
빠른 시작과 수동 env 블록, 기본/소형 모델 슬롯 피커, 모델 매핑 편집기, 피커가 발견할 별칭
미리보기. 사이드바에는 **Claude ON** 토글도 있습니다 (라벨은 의도적으로 모든 언어에서
동일합니다) — 인바운드를 켜고 끕니다.

## 모델 매핑

`claudeCode.modelMap`은 인바운드 Anthropic 모델 id를 라우팅 전에 재작성합니다:

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

조회 순서: 디스커버리 별칭 → 정확한 id → 날짜 접미사 제거(`-20250514`) → 통과.

## 수동 설정 (ocx 없이)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

또는 `~/.claude/settings.json`의 `env` 키에 저장하세요. 프록시가 admission 키를 요구하지 않는
한 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`는 설정하지 마세요 — 어떤 인증 오버라이드든
claude.ai 커넥터를 끄고 구독 로그인을 대체해버립니다.

## 참고 사항과 한계

- **스트리밍 우선.** 인바운드는 내부적으로 항상 스트리밍합니다; 논스트리밍 클라이언트는 접힌
  message JSON을 받습니다.
- **Thinking.** 추론은 `thinking` 블록으로 Claude Code에 스트리밍됩니다(합성 서명 포함);
  Claude Code가 재전송한 thinking 블록은 라우팅 전에 제거됩니다 — 프로바이더는 자체 봉투로
  추론을 유지합니다.
- **count_tokens는 추정치입니다.** Claude Code의 컨텍스트 미터는 문자 기반 근사를 사용합니다;
  이 엔드포인트는 게이트웨이 프로토콜에서 선택 사항입니다.
- **킬 스위치.** `claudeCode.enabled: false` (GUI: Claude ON 토글)는 `/v1/messages`에 403을
  응답하고 디스커버리 목록을 비웁니다.
- 요청은 다른 라우팅 트래픽과 동일하게 Logs/Usage 페이지에 나타납니다.
