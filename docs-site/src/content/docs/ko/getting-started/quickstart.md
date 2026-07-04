---
title: Quickstart
description: 첫 프로바이더를 설정하고 명령어 세 개로 OpenAI Codex를 opencodex로 라우팅합니다.
---

이 가이드는 새로 설치한 상태에서 OpenAI가 아닌 모델로 Codex를 실행하기까지의 과정을 안내합니다.

## 1. 설정 마법사 실행

```bash
ocx init
```

`ocx init`은 다음 과정을 안내합니다:

1. **프로바이더 선택** — 프리셋(opencode zen, Anthropic, OpenAI, OpenAI API key, OpenRouter, Groq, Google,
   Azure)을 고르거나, `custom`을 선택해 base URL과 adapter를 직접 입력합니다.
2. **API 키** — 키를 붙여넣거나, `${ANTHROPIC_API_KEY}`와 같은 환경 변수를 참조합니다.
3. **기본 모델** — 요청이 다른 프로바이더와 매칭되지 않을 때 사용되는 모델입니다.
4. **프록시 포트** — 기본값은 `10100`입니다.
5. **Codex에 주입할까요?** — 동의하면 opencodex가 `[model_providers.opencodex]` 테이블을
   `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 기록하고, `model_provider = "opencodex"`로 설정해 Codex가 프록시를 통해 라우팅하도록 합니다.

결과는 `~/.opencodex/config.json`에 저장됩니다.

## 2. 프록시 시작

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

시작 시 opencodex는:

- PID를 `~/.opencodex/ocx.pid`에 기록하고(두 번 실행되는 것을 거부),
- 각 프로바이더의 실시간 모델 목록을 가져와 **Codex의 모델 카탈로그에 동기화**하며,
- `http://localhost:<port>/v1`에서 수신 대기합니다.

확인:

```bash
ocx status
```

## 3. Codex 사용

이제 Codex는 opencodex와 투명하게 통신합니다:

```bash
codex "Refactor this function for readability"
```

특정 라우팅 모델을 지정하려면, Codex의 모델 선택기에 표시되는 `provider/model` 형식을 사용하세요:

```bash
codex -m "anthropic/claude-opus-4-8" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

GPT-5.6 Sol/Terra/Luna는 preview 권한이 있는 계정 또는 프로바이더에서만 사용할 수 있습니다.
권한이 있다면 native ChatGPT 경로는 bare 모델명, API 키와 OpenRouter 경로는 명시적
`provider/model` 형식을 사용하세요:

```bash
codex -m "gpt-5.6-sol"                    "Plan a risky refactor"
codex -m "openai-apikey/gpt-5.6-terra"    "Review this architecture"
codex -m "openrouter/openai/gpt-5.6-luna" "Summarize this trace"
```

## 키를 붙여넣는 대신 로그인하기

일부 프로바이더는 실제 계정 로그인을 지원합니다(OAuth, 자동 갱신):

```bash
ocx login xai          # or: anthropic, kimi
ocx logout xai
```

기본 OpenAI 경로는 **키가 필요 없습니다** — 기존 `codex login` 자격 증명을 그대로 포워딩합니다.
OpenAI API 키를 따로 쓰려면 `openai-apikey` 프로바이더를 추가하세요. 이 경로는 preview 권한이
있는 API 키에서 `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` seed/fallback 모델명을 제공합니다
([프로바이더](/opencodex/ko/guides/providers/) 참고).

## 중지 및 복원

```bash
ocx stop      # stop the proxy and restore native Codex
ocx restore   # restore native Codex without stopping (alias: ocx eject)
```

## 다음

- [작동 방식](/opencodex/ko/getting-started/how-it-works/) — 각 요청에 무슨 일이 일어나는지.
- [프로바이더](/opencodex/ko/guides/providers/) — 인증하는 모든 방법.
- [구성](/opencodex/ko/reference/configuration/) — 전체 `config.json` 레퍼런스.
