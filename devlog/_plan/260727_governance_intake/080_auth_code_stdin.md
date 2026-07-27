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

---

## 계획 감사 (agent 019fa1d4) → 설계 수정

감사가 blocker 2건 + High 3건을 냈다. 둘은 프로브로 직접 확인했다.

### 실측한 것

```
[login --code=<secret>]  leaks=true
   stderr> Error: Unexpected argument(s): --code=https://cb.example/?code=SUPERSECRET123&state=x
[code openai --flow flow-123]  → Error: Unexpected argument(s): flow-123
```

첫째, `takeOption`은 `--code <값>`만 받는다. `--code=<값>`은 파싱에서 빠져
`rejectArgs`로 흘러가고, **거기서 인자를 통째로 stderr에 찍는다.** 즉 인증
코드를 등호로 붙이면 셸 히스토리뿐 아니라 프로그램 출력에도 남는다. 원래
계획의 "값은 어디에도 안 나온다"가 이 경로에서 거짓이었다.

둘째, `code()`는 플래그를 파싱하기 전에 `args.shift()`로 위치 인자를 먼저
먹는다. `ocx account code openai --flow flow-123`은 `--flow`를 코드로 삼고
남은 `flow-123`을 "예상치 못한 인자"라고 거절한다. 위치 인자를 선택으로
만들기 **전에** 이 순서부터 뒤집어야 한다.

### 수정된 설계

- **`login`의 기본 동작은 건드리지 않는다.** 감사 지적대로 `--code` 없는
  `ocx account login`은 지금처럼 브라우저 플로우를 열고 폴링한다. stdin을
  기본으로 삼으면 평범한 로그인이 전부 프롬프트에서 멈춘다. stdin은
  `account code <provider>` (위치 인자 생략)와 명시적 `--code -`에만 붙인다.
- **`code()` 파싱 순서를 뒤집는다.** 플래그를 먼저 걷어내고 남은 토큰 0~1개를
  위치 인자로 본다. 플래그가 앞뒤 어디 있어도 동작한다.
- **등호 문법을 지원하고 경고한다.** `--code=<값>`을 받아들이되 stderr 경고를
  낸다. 받아들이지 않으면 `rejectArgs`가 값을 찍기 때문에, 거절이 오히려 더
  샌다. 아울러 `rejectArgs` 경로로 갈 수 있는 잔여 인자 중 `--code=`로
  시작하는 것은 값을 잘라내고 `--code=<redacted>`로 보고한다.
- **TTY 에코 보장 범위를 정직하게 적는다.** readline 프롬프트는 터미널 화면에
  붙여넣은 값을 보여준다. 이 변경이 막는 것은 **셸 히스토리, `ps`, 그리고
  프로그램 자신의 출력**이다. 터미널 화면은 막지 않는다 — 그건 별개 문제이고,
  기존 대화형 경로(`login-cli.ts:55`)도 같은 성질이다.
- **`ocx account` 총괄 USAGE도 같이 고친다** (`src/cli/account.ts:28`).
  `ACCOUNT_AUTH_USAGE`만 고치면 알 수 없는 서브커맨드에서 옛 문법이 나온다.
- stdin 헬퍼는 `account-extended.ts`의 `readStdinLine`과 같은 모양으로
  `RuntimeApiDeps`에 `stdinImpl` / `stdinTimeoutMs`를 얹는다. 테스트 하네스에
  이미 `stdinFrom`이 있다.

### 수용 기준 (교체)

- `account code <p>` — stdin(파이프)에서 읽고, 인자 경로와 **동일한 요청 본문**
- `account code <p> -` / `login --code -` — 명시적 stdin, 경고 없음
- `account code <p> <값>` / `--code <값>` — 동작하되 stderr 경고, 값 미노출
- `--code=<값>` — 동작하되 경고, **값이 출력에 없다** (지금은 샌다)
- `code <p> --flow <id>` — `--flow`를 코드로 먹지 않는다 (지금은 먹는다)
- 빈 파이프 / 닫힌 stdin — usage 오류, POST 없음
- `--code` 없는 평범한 `login`과 `--no-wait`는 **동작 변화 없음**
- Codex 경로(`--flow` 필수)와 OAuth 경로 양쪽 본문 확인
