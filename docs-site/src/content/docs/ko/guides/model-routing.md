---
title: 모델 라우팅
description: opencodex가 주어진 모델 id를 어느 프로바이더가 처리할지 결정하는 방식.
---

Codex가 모델을 요청하면 `router.ts`가 이를 정확히 하나의 설정된 프로바이더로 해석합니다. 규칙은
**순서대로** 검사되며, 첫 번째로 일치하는 것이 적용됩니다.

## 우선순위

1. **명시적 `provider/model`** — id에 `/`가 포함되어 있고 그 앞부분이 설정된 프로바이더의 이름이면,
   해당 프로바이더가 사용되며 id는 슬래시 뒷부분으로 잘립니다.

   ```text
   anthropic/claude-opus-4-8   →  provider "anthropic",   model "claude-opus-4-8"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   ```

   이는 명확한 형식이며, Codex의 모델 선택기가 라우팅된 모델에 사용하는 형식입니다.

2. **프로바이더의 `defaultModel`** — 어떤 프로바이더의 `defaultModel`이 id와 일치하면 해당 프로바이더가
   사용됩니다(id는 변경 없이 그대로 전달됩니다).

3. **프로바이더의 `models[]`** — 어떤 프로바이더가 `models[]`에 id를 나열하고 있으면 해당 프로바이더가 사용됩니다.

4. **빌트인 프리픽스 패턴** — id를 알려진 모델 제품군 프리픽스와 대조한 뒤, 해당 이름(또는 이름
   프리픽스)의 설정된 프로바이더로 라우팅합니다:

   | 프리픽스 | 프로바이더 |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `gpt-`, `o1-`, `o3-`, `o4-` | `chatgpt` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

5. **기본 프로바이더** — 어느 것도 일치하지 않으면 id는 변경 없이 `config.defaultProvider`로 전송됩니다.
   (기본 프로바이더가 설정되지 않은 경우 라우팅은 예외를 발생시킵니다.)

## API 키와 환경 변수

어느 경로가 선택되든, 프로바이더의 `apiKey`는 `resolveEnvValue()`를 통해 해석됩니다:
`${OPENAI_API_KEY}` 또는 `$OPENAI_API_KEY` 값은 요청 시점에 환경에서 확장되므로 비밀 값을
`config.json`에 둘 필요가 전혀 없습니다.

## 팁

- **라우팅된 모델에는 명시적으로 작성하세요.** `provider/model`(규칙 1)을 선호하세요 — 명확하고 카탈로그
  동기화 후 Codex가 선택기에 표시하는 것과 일치합니다.
- 프로바이더에 **`models[]` 또는 `defaultModel`을 미리 채워두면** 짧은 id(규칙 2/3)가 `provider/`
  프리픽스 없이 해석됩니다.
- **프리픽스 패턴은 편의 기능**일 뿐 보장이 아닙니다: 해당 이름(예: `anthropic`, `openai`, `groq`)의
  프로바이더가 실제로 설정되어 있을 때만 해석됩니다.

이 규칙들이 읽는 프로바이더 필드는 [설정](/opencodex/ko/reference/configuration/)을 참고하세요.
