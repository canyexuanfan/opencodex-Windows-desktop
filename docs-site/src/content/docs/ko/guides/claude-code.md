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

## 시스템 환경 통합

macOS에서 `ocx start`를 실행하면 `launchctl setenv`를 통해 `ANTHROPIC_BASE_URL`과 관련 Claude Code
환경변수를 시스템 전역에 자동으로 설정합니다. 따라서 새 터미널 창과 탭에서는 `ocx claude`
래퍼 없이 일반 `claude` 명령도 프록시를 통해 라우팅됩니다. 이미 열려 있던 셸에는 변경 사항이
적용되지 않으므로 새로 열어야 합니다.

`ocx stop` 또는 프록시 종료 시 환경변수는 이전 상태로 복원됩니다. 설정에서
`claudeCode.systemEnv: false`를 지정하거나 GUI 토글을 사용해 이 기능을 끌 수 있습니다. 이 기능은
macOS 전용이며, 다른 플랫폼에서는 `ocx claude`로 Claude Code를 실행하세요.

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
시작하는 id만 받아들이므로, opencodex는 라우팅 모델을 안정적이고 가역적인 별칭으로 노출합니다 —
표면마다 다른 계열을 씁니다:

```
claude-ocx-<provider>--<model>     Claude Code CLI (가독형, 예: claude-ocx-native--gpt-5.6-sol)
claude-opus-4-8-<code>             Claude Desktop 3P (해시형, 예: claude-opus-4-8-ncb)
```

계열은 요청마다 정해집니다: `?ids=cli|desktop`이 최우선이고, 없으면 Claude Code 디스커버리
user-agent(`claude-code/<버전>`)는 가독형을, 그 외 클라이언트는 해시형을 받습니다. 두 계열
모두(그리고 `--model gpt-5.6-sol` 같은 bare id도) 영구히 디코드되므로 `settings.json`에 어떤
형태로 저장돼 있든 계속 동작합니다 — 이번 변경 후 예전 해시형 선택값은 목록에서 다시
고르기 전까지 커스텀 항목으로 보일 뿐입니다. 가독형으로 표현 불가한 라우트(프로바이더
이름에 `--`나 `/` 포함)는 해시형으로 폴백해 모델이 사라지지 않습니다.

각 항목은 `gemini-3-pro (gemini)` 같은 정직한 표시 이름과 함께, 공식 ModelInfo 형태의 모델
능력 정보(추론 강도 사다리, thinking 타입)를 실어 보냅니다 — Claude Desktop의 서드파티
게이트웨이 모드가 추론 강도 선택 UI를 열 수 있게 하기 위해서입니다. 실제 Anthropic 모델은
원래 id를 그대로 유지합니다. 구버전 설정의 `claude-ocx-<provider>--<model>` 별칭도 계속
해석됩니다. 컨텍스트가 1M인 모델에는 `…[1m]` 행이 하나 더 생깁니다 — 이걸 고르면 Claude
Code가 그 모델의 컨텍스트를 1M로 계산합니다(자동 요약 유지, 프록시가 표식을 떼고 라우팅).

### 자동 컨텍스트 (200k 한계 없이 큰 컨텍스트 쓰기)

Claude Code는 모르는 모델의 컨텍스트를 무조건 200k로 계산합니다 — 실제로는 372k, 400k를
기억할 수 있는 모델이라도요. **자동 컨텍스트**(기본 켜짐)는 이를 두 단계로 풉니다:

1. 실제 윈도우가 200k를 넘고 자동 요약 지점 이상인 모델의 픽커 행과 env 슬롯에 `[1m]`
   표식을 붙입니다 (Claude Code가 그 모델을 1M로 계산).
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(기본 `350000`)를 주입해 그 지점에서 대화를 자동
   요약합니다. Claude Code는 `min(계산된 윈도우, 이 값)`을 쓰기 때문에 env 하나가 모델별
   하한처럼 동작합니다 — 표식 붙은 모델은 350k에서 요약되고, 200k 모델은 평소대로 갑니다.

값은 Claude 페이지에서 조정할 수 있습니다(허용 범위 100000~1000000). **주의:** 모델의 실제
윈도우보다 크게 잡으면 그 모델은 요약되기 전에 오류로 멈춥니다. 1M 미만의 순정 Anthropic
모델에는 절대 자동 표식이 붙지 않고, 직접 export한 값이 항상 우선합니다(프록시는 그 값을
기준으로 어떤 모델이 안전한지 다시 판단합니다). 레거시 `maxContextTokens`를 설정하면 자동
컨텍스트는 통째로 꺼집니다.
선택하면 Claude Code의 `settings.json` `model` 필드에 저장되고, 인바운드 요청에서
별칭이 라우팅 모델로 되돌려집니다. 구버전 Claude Code에서는 `ANTHROPIC_MODEL`로 슬롯을
지정하거나 `/model`에 라우팅 id를 직접 입력하세요 (Claude Code는 문자열을 그대로 통과시킵니다).

## 서브에이전트 티어 모델

Claude Code 서브에이전트는 `opus` / `sonnet` / `haiku` / `fable` 별칭으로 모델을 고릅니다.
특정 라우팅 모델 파견은 위의 로스터 에이전트(`ocx-*`)가 정석이라, 티어 매핑은 이제
설정 파일 전용입니다(`claudeCode.tierModels` — GUI 컨트롤 없음). 설정하면 `ocx claude`(및
시스템 환경 변수 옵션)가 `ANTHROPIC_DEFAULT_*_MODEL`로 주입합니다. haiku는 백그라운드
보조 슬롯을 따르고,
1M 모델에는 `[1m]`이 자동으로 붙습니다. 직접 export한 값이 항상 우선합니다.

## GUI

대시보드에 전용 **Claude** 페이지가 있습니다 (사이드바에서 API 아래): 인바운드 킬 스위치,
빠른 시작과 수동 env 블록, 백그라운드 보조 모델 피커, 모델 가로채기(modelMap) 편집기, 피커가 발견할 별칭
미리보기. 사이드바에는 **Claude ON** 토글도 있습니다 (라벨은 의도적으로 모든 언어에서
동일합니다) — 인바운드를 켜고 끕니다.
기본 메인 모델은 Claude Code 자체의 `/model` 픽커가 관리하므로(자기 `settings.json`에 저장)
이 페이지에서는 중복 제공하지 않습니다.

## 로스터 에이전트 (injectAgents)

`ocx claude`(및 시스템 env 데몬)가 '서브에이전트' 탭에서 고른 모델(최대 5개)과
`ocx-self` — `/model` 픽커 기본값에 고정(없으면 `claudeCode.model`, 둘 다 없으면 생략) —
를 `~/.claude/agents/ocx-*.md`로 동기화합니다. `subagent_type: "ocx-gpt-5-6-sol"`처럼 어떤
라우팅 모델이든 파견할 수 있습니다. Claude Code가 에이전트 정의의 커스텀 게이트웨이 id를
무시하기 때문에, 각 본문에 실린 `<!-- ocx-route: ... -->` 지시자를 프록시가 읽어 실제
라우팅을 고정합니다 — 그래서 이 에이전트들에는 Agent 도구의 `model` 인자가 무의미해요
(자리채움으로 `"sonnet"`을 넣거나 생략). 1M급
모델에는 `[1m]`이 자동으로 붙습니다. 마커로 검증된 `ocx-*.md`만 덮어쓰거나 정리하며 직접
만든 에이전트는 절대 건드리지 않습니다. `claudeCode.injectAgents: false`로 끄면 소유
파일이 정리됩니다.

## 번들 스킬 차단 (blockedSkills)

Claude Code의 번들 `claude-api` 스킬은 로드되는 순간 약 840KB(약 13.6만 토큰)의 Anthropic
문서 뭉치를 대화에 주입하고, Claude 모델 이름을 지나가듯 언급만 해도 자동 발동합니다
(anthropics/claude-code#74473, #63566, #69164). 타사 라우팅 모델은 이 문서로 학습되지
않았으므로, opencodex는 기본적으로 라우팅 요청에서 해당 스킬의 tool 결과 본문을 짧은
안내문으로 치환합니다. 네이티브 Anthropic 패스스루는 건드리지 않아 Claude 모델은 전체
내용을 그대로 받습니다. `claudeCode.blockedSkills`로 설정합니다 (기본 `["claude-api"]`,
`[]`이면 끔, 이름을 추가하면 확장). 치환은 tool 호출/결과 짝을 유지하므로 재전송이
깨지지 않습니다.

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

## 추론 강도

Claude Code의 `/effort` 설정은 어댑터를 지나서도 보존됩니다. adaptive 와이어 형식
(`thinking: { type: "adaptive" }` + `output_config: { effort }`)의 effort는 그대로 전달됩니다.
레거시 `thinking.enabled` 요청은 `budget_tokens`가 4096 이하면 `low`, 16384 이하면 `medium`,
그보다 크면 `high`로 매핑됩니다. 서브에이전트에서 흔히 쓰이는 thinking disabled 요청에는 추론
강도를 프록시가 의도적으로 빼고 보냅니다 (클라이언트가 끈 추론을 라우팅 제공자에 강제하지 않기 위해서예요). 결정된 값은 요청 로그의 **추론 강도** 컬럼에 표시됩니다.

## 프롬프트 캐싱

- Anthropic 라우팅 요청에서 어댑터는 tools, system 콘텐츠, 끝에서 두 번째 user 메시지에 캐시
  브레이크포인트를 관리하고, top-level automatic `cache_control`도 적용합니다. 안정적인 턴은
  일반적으로 약 99.9%의 캐시 히트율을 냅니다.
- 네이티브 OpenAI/ChatGPT 라우팅은 세션 범위의 `prompt_cache_key`와 `session_id` 헤더를 합성해
  캐시 어피니티를 유지합니다.
- `CLAUDE.md`는 첫 user 메시지에만 주입되므로 매 턴 프롬프트 캐시를 무효화하지 않습니다.

## Logs와 Usage의 토큰 사용량

요청 로그의 총합은 입력(캐시된 입력 포함) + 출력입니다. `c` 접미사는 캐시 읽기(히트), `w`는
캐시 쓰기(생성)를 뜻합니다. Usage 페이지도 캐시 히트와 캐시 생성을 따로 표시합니다.

## 수동 설정 (ocx 없이)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

또는 `~/.claude/settings.json`의 `env` 키에 저장하세요. 프록시가 admission 키를 요구하지 않는
한 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`는 설정하지 마세요 — 어떤 인증 오버라이드든
claude.ai 커넥터를 끄고 구독 로그인을 대체해버립니다.

## 프로덕션 노트

- **스트리밍 우선.** 인바운드는 내부적으로 항상 스트리밍합니다; 논스트리밍 클라이언트는 접힌
  message JSON을 받습니다.
- **Thinking.** 추론은 `thinking` 블록으로 Claude Code에 스트리밍됩니다(합성 서명 포함);
  Claude Code가 재전송한 thinking 블록은 라우팅 전에 제거됩니다 — 프로바이더는 자체 봉투로
  추론을 유지합니다.
- **에러.** 업스트림 실패는 Anthropic 에러 택소노미로 매핑됩니다: 400, 401, 403, 404;
  429는 `rate_limit_error`; 529는 `overloaded_error`; 그 밖의 5xx는 `api_error`입니다.
  `Retry-After`는 보존됩니다.
- **count_tokens는 라우팅을 따릅니다.** 라우팅 모델은 근사치를 사용합니다. `sk-ant` 자격증명을
  쓰는 네이티브 Anthropic 모델은 실제 Anthropic API로 요청을 패스스루합니다.
- **SSE 스트리밍.** 스트리밍 응답은 server-sent events를 사용하며 `ping` 이벤트를 포함합니다.
- **킬 스위치.** `claudeCode.enabled: false` (GUI: Claude ON 토글)는 `/v1/messages`에 403을
  응답하고 디스커버리 목록을 비웁니다.
- 요청은 다른 라우팅 트래픽과 동일하게 Logs/Usage 페이지에 나타납니다.
