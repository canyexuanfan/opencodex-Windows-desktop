# WP9 — `ocx account`의 인증 코드를 셸 인자에서 걷어내기

## 어디서 나왔나

WP8(main 승격) 사전 감사가 승격을 막으면서 낸 High 지적이다. 승격은 접었지만
지적 자체는 dev 코드에 그대로 남아 있으므로 여기서 처리한다.

## 문제

`918a0c8d`가 추가한 헤드리스 CLI가 OAuth 인증 코드를 **명령줄 인자**로 받는다.

- `src/cli/account-auth.ts` USAGE: `ocx account code <provider> <redirect-or-code>`
- 같은 파일 `login()`: `--code <redirect-or-code>`

인증 코드가 담긴 리다이렉트 URL은 단기 자격증명이다. 인자로 주면
`~/.zsh_history`에 남고, 실행 중에는 같은 호스트의 다른 프로세스가 `ps`로
읽는다. 대화형 경로인 `src/oauth/login-cli.ts:55`는 같은 값을 readline 프롬프트로
받는다 — 즉 이 저장소는 이미 안전한 방식을 알고 있고, 헤드리스 경로만 그걸
따르지 않는다.

## 고칠 형태

인자 수용을 없애는 게 아니라 **기본값을 뒤집는다.** 헤드리스 자동화가 진짜
필요할 수 있으므로 경로는 남기되, 아무 표시 없이 쓰이지는 않게 한다.

1. `<redirect-or-code>` 위치 인자와 `--code`를 선택으로 만들고, 없으면
   **stdin에서 읽는다.** 파이프(`echo … | ocx account code x`)와 TTY 프롬프트
   양쪽을 지원한다.
2. 인자로 준 경우 stderr에 한 줄 경고: 셸 히스토리와 프로세스 목록에 남는다는
   사실과, 대신 쓸 수 있는 stdin 형태를 같이 말한다.
3. `--code -` / 위치 인자 `-`는 "명시적으로 stdin"을 뜻하게 해서, 경고 없이
   자동화할 수 있는 정식 경로를 준다.

값 자체는 절대 에코하지 않는다 — 경고문에도, 로그에도.

## 파일

- `src/cli/account-auth.ts` — `login()`의 `--code`, `code()`의 위치 인자, USAGE
- `src/cli/runtime-api.ts` — stdin 읽기 헬퍼를 여기 두고 `RuntimeApiDeps`에
  주입 가능하게 한다 (테스트가 실제 stdin 없이 돌아야 함)
- `tests/cli-account.test.ts` — 회귀

## 수용 기준

- stdin으로 준 코드가 인자로 준 것과 동일한 요청 본문을 만든다
- 인자로 주면 경고가 stderr에 나오고, **코드 값은 어디에도 안 나온다**
- `-`는 stdin을 읽고 경고하지 않는다
- stdin이 비었고 TTY도 아니면 usage 오류
- `bun run test` 전체 통과, `bun x tsc --noEmit` exit 0
