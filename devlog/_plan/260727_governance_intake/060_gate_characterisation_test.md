# 060 — enforce-pr-target.yml 특성화 테스트 (WP6)

## 왜 이 테스트가 필요했나

`.github/workflows/enforce-pr-target.yml`은 이 저장소에서 유일하게 **기여자의 PR을
직접 변경**하는 워크플로다. 제목에 `[WRONG BRANCH] ` 접두사를 붙이고 PR을 draft로
강등한다. 게다가 `pull_request_target`으로 돌아 그 작업을 base 저장소의 write 토큰을
쥔 채 수행한다. 그런데 테스트가 하나도 없었다.

040(게이트 재설계)이 감사 6회 중 5회 FAIL을 받은 이유도 여기에 있다. 현재 동작이
어디까지 보장되는지 아무도 고정해두지 않은 상태에서 재설계 안을 세 번 썼고, 세 번 다
무너졌다. 재설계 전에 현재 동작을 먼저 못 박는다.

이 테스트는 **바람직한 동작이 아니라 현재 동작**을 고정한다. 게이트를 고칠 때 무엇이
깨지는지 보이게 하는 것이 목적이다.

## 무엇을 고정했나

`tests/ci-workflows.test.ts`에 4개 테스트를 추가했다.

| 테스트 | 고정하는 성질 |
| --- | --- |
| stays least-privilege and never runs PR code | 트리거는 `pull_request_target` 하나뿐, `permissions`는 `{pull-requests: write}` 정확히 일치, 모든 step에 `run` 없음, 모든 `uses`가 40자리 SHA 핀, `actions/checkout` 없음, concurrency group이 PR 번호 단위 |
| reacts to the events that can change the verdict | `types`가 정확히 `opened/reopened/edited/ready_for_review`, `pulls.get`으로 라이브 재조회, `wrongBase`가 `pr.base.ref !== EXPECTED_BASE`에서 파생 |
| records what it changed so it can undo it | 상태 마커 저장/복원, 봇이 draft로 만든 경우에만 되돌림 |
| (기존 3개 워크플로 테스트) | 회귀 없음 |

## 문자열 매칭에서 파싱으로 — 감사가 밀어붙인 변경

1차 구현은 워크플로 텍스트를 grep했다. 감사 2라운드가 이걸 네 가지로 뚫었다.

- `- run : echo pwn` — 콜론 앞 공백. 유효한 YAML이고, `/- run:/` 정규식은 못 잡는다.
- `- 'uses': owner/action@feature` — 인용된 키. 역시 유효한 YAML이고 SHA 핀 검사를 우회한다.
- `// await convertToDraft();` — 주석 처리. "이 문자열을 포함한다" 검사는 그대로 만족한다.
- `const wrongBase = false;` — 상수는 남기고 판정만 하드코딩.

그래서 `Bun.YAML.parse()`로 전면 교체했다. 파서는 철자가 아니라 키를 본다.
스크립트 본문은 `//` 주석을 제거한 뒤 검사하되, 제거기가 인용 상태를 추적한다 —
스크립트가 메시지에 `https://…`를 담고 있어서 순진한 `line.replace(/\/\/.*$/, "")`는
문자열 리터럴을 잘라먹고 그 뒤 검사를 조용히 무력화한다.

## 변이 검증 실측

교체 후 감사가 찾은 네 가지를 직접 주입해 재실행했다. 각 변이 후 즉시
`git checkout -- .github/workflows/enforce-pr-target.yml`로 원복했다.

```
MUTATION[run-with-space]      => 13 pass  1 fail
MUTATION[quoted-uses-key]     => 13 pass  1 fail
MUTATION[commented-out-draft] => 13 pass  1 fail
MUTATION[hardcoded-wrongBase] => 13 pass  1 fail
--- restored, baseline: git status --short .github/ → (empty)
```

기준선:

```
bun test tests/ci-workflows.test.ts
 14 pass  0 fail  282 expect() calls  (감사 2라운드 이전 기준선)
```

네 가지 모두 잡힌다.

## 감사 2라운드 — 새 우회 6가지

파싱 교체본을 독립 서브에이전트(gpt-5.6-terra, medium)에 넘겨 "이 테스트를 통과하면서
워크플로를 약화시켜 보라"고 요구했다. FAIL이 나왔고, 여섯 개가 살아남았다.

| 변이 | 무엇이 뚫렸나 |
| --- | --- |
| 두 번째 잡 추가 | 헬퍼가 `jobs["enforce-target"]`만 읽어서, PR-write 토큰을 상속받는 `sidecar:` 잡을 붙여 PR을 un-draft해도 통과 |
| 잡 레벨 권한 | 워크플로 레벨 `permissions`만 검사. 잡에 `contents: write`를 얹으면 무사통과 |
| 스텝 추가 | 스텝 개수를 안 봤다. PR을 변조하는 `github-script` 스텝을 하나 더 붙여도 통과 |
| `/* ... */` 블록 주석 | 주석 제거기가 `//`만 처리. 블록 형태로 `convertToDraft()`를 죽이면 통과 |
| `|| true` 복원 무력화 | `if (!storedState?.active \|\| true)` — 복원 경로가 도달 불가가 되어도 호출과 필드는 텍스트로 남아 있어 통과 |
| PR 제목을 대상 번호로 | `pull_number`를 `Number(pr.title)`로 바꿔도 통과. 작성자가 제어하는 값이므로 봇이 임의 PR에 대한 쓰기 프리미티브가 된다 |

마지막 것이 가장 나쁘다. 봇은 `pull_number` 하나로만 PR을 지목하는데, 그게 작성자
제어 값이 되면 게이트가 아니라 무기가 된다.

## 대응

- 헬퍼가 **모든 잡의 모든 스텝**을 모아 반환한다. `enforce-target`은 특별한 잡이 아니라
  스크립트 본문을 읽을 대상일 뿐이다.
- 잡 목록이 정확히 `["enforce-target"]`, 스텝 수가 정확히 1.
- 어떤 잡도 자체 `permissions`를 선언할 수 없다.
- 주석 제거기가 라인 주석과 블록 주석을 모두 처리한다. 인용 추적은 유지하고 줄바꿈을
  보존해 실패 출력이 엉뚱한 줄을 가리키지 않게 했다.
- `pull_number`는 `context.payload.pull_request.number`에 고정하고, 재대입이 없음을
  대입 횟수로 확인한다.
- 두 분기 조건(`if (wrongBase)`, `if (!storedState?.active)`)을 문자 그대로 고정한다.
  호출이 존재한다는 사실은 그 호출에 도달할 수 있다는 증명이 아니다.

## 변이 검증 실측 (10/10)

```
MUTATION[run-with-space        ] => CAUGHT
MUTATION[quoted-uses-key       ] => CAUGHT
MUTATION[line-comment-draft    ] => CAUGHT
MUTATION[block-comment-draft   ] => CAUGHT
MUTATION[hardcoded-wrongBase   ] => CAUGHT
MUTATION[second-job            ] => CAUGHT
MUTATION[job-level-perms       ] => CAUGHT
MUTATION[extra-script-step     ] => CAUGHT
MUTATION[unreachable-restore   ] => CAUGHT
MUTATION[pr-controlled-target  ] => CAUGHT

restored OK; survived = none
```

기준선: `14 pass  0 fail  292 expect() calls`, `bun run typecheck` 오류 0.

## 감사 3라운드 — 열거 게임의 종료

봉쇄본을 다시 독립 감사에 넘겼다. 또 FAIL, 이번엔 14가지가 살아남았다.

`if: false`(잡/스텝 양쪽), `runs-on: self-hosted`, `container: node:22`,
`strategy.matrix`, `outputs.leaked: ${{ github.token }}`, `<<:` 병합 키로 `if: false`
주입, `github-token: ${{ secrets.SOME_PAT }}`, `result-encoding`, 잡 레벨 `env:`에
PR 제목 주입, `cancel-in-progress`, 그리고 스크립트 안쪽으로 `${{ ... }}` 보간,
`pr.base.ref = EXPECTED_BASE` 되쓰기, `issue_number: 1`, `base: "main"` 추가.

여기서 패턴이 보인다. **살아남은 것은 전부 "원래 없던 키"다.** 세 라운드 내내 우리는
"이 키는 없어야 한다"를 하나씩 늘려왔는데, 그건 감사자가 생각해낸 것만 덮는다.
다음 라운드에는 다음 키가 나온다. 끝나지 않는다.

### 설계 반전 — 부정 목록에서 허용 목록으로

무엇이 없어야 하는지가 아니라 **무엇인지**를 열거한다.

- 최상위 키 집합이 정확히 `[concurrency, jobs, name, on, permissions]`
- `concurrency` 객체 전체가 `{group: ...}` 하나 (`cancel-in-progress` 자동 차단)
- 잡 키 집합이 정확히 `[runs-on, steps]`, `runs-on`은 `ubuntu-latest` 고정
  → `if`, `permissions`, `container`, `strategy`, `outputs`, `env`, `defaults`, `<<`
  전부 한 어설션에 걸린다
- 스텝 키 집합이 정확히 `[name, uses, with]`, `with` 키가 정확히 `[script]`
  → `github-token`, `result-encoding`, 스텝 `if` 전부 차단
- `uses`는 `^actions/github-script@[0-9a-f]{40}$`

이 방식의 값어치는 **아직 발명되지 않은 키도 걸린다**는 것이다. 새 키가 추가되면
어떤 키든 여기서 실패하고 사람이 읽게 된다. 권한 있는 워크플로의 특성화 테스트에
필요한 성질이 바로 그거다.

### 스크립트 쪽 — 보간 금지와 인자 화이트리스트

`${{ }}`는 Actions가 node 실행 **전에** 스크립트 텍스트로 치환한다. 그래서 백틱이
들어간 PR 제목은 데이터가 아니라 코드다. `pull_request_target`의 교과서적 주입 지점.
스크립트 원문에 `${{`가 하나도 없어야 한다 — 필요한 값은 이미 런타임에 `context`에서
읽고 있다.

`pr` 객체에 대한 필드 대입도 전면 금지한다. 감사는 요구 비교문을 글자 그대로 남겨둔
채 한 줄 위에서 `pr.base.ref = EXPECTED_BASE;`로 판정을 죽였다. 리터럴은 그대로,
결과는 항상 false.

쓰기 호출은 인자 이름까지 고정한다. `pulls.update`는 `base`, `state`, `body`를 받는다.
인자 목록이 열려 있으면 write 토큰을 쥔 봇이 PR을 리타깃하거나 닫을 수 있다는 뜻이다.
`issue_number`는 리터럴 금지, `pull_number` 바인딩만 허용. 변조 REST 호출은 정확히
세 개(`pulls.update`, `issues.createComment`, `issues.updateComment`)여야 한다.

## 변이 검증 실측 (27/27)

3개 라운드가 찾은 모든 우회 + 파생 2건을 재주입했다. 각 변이 후 즉시
`git checkout -- .github/workflows/enforce-pr-target.yml`.

```
run-with-space CAUGHT      quoted-uses-key CAUGHT     line-comment-draft CAUGHT
hardcoded-wrongBase CAUGHT block-comment-draft CAUGHT second-job CAUGHT
job-level-perms CAUGHT     extra-script-step CAUGHT   unreachable-restore CAUGHT
pr-controlled-target CAUGHT pat-override CAUGHT       job-env-pr-title CAUGHT
job-if-false CAUGHT        step-if-false CAUGHT       self-hosted-runner CAUGHT
unpinned-container CAUGHT  script-injection CAUGHT    pr-field-writeback CAUGHT
comment-other-issue CAUGHT constant-concurrency CAUGHT cancel-in-progress CAUGHT
merge-key-disable CAUGHT   extra-with-input CAUGHT    nul-title-prefix CAUGHT
matrix-and-outputs CAUGHT  update-retargets-main CAUGHT update-closes-pr CAUGHT

survived = none
```

기준선: `16 pass  0 fail  303 expect() calls`, `bun run typecheck` 오류 0.

한 가지 실측 정정: 계획은 `pulls.update`가 1회 호출된다고 봤는데 실제로는 2회다
(접두사 부착, 그리고 리타깃 후 제거). 어설션을 실제 트리에 맞췄다.

## 감사 4라운드 — 정적 고정의 한계, 그리고 실행 하네스

허용 목록 버전을 다시 감사에 넘겼다. YAML 쪽은 버텼다. `True:`(YAML 1.1 불린 강제),
flow 스타일 `{group: ...}`, `runs-on: [ubuntu-latest]`, 다중 문서 `---` 전부 잡혔다.
인용 키·순서 변경·앵커·스텝 이름 변경은 살아남았지만 파싱 결과가 동일하므로
행위 우회가 아니다.

무너진 건 전부 스크립트 안쪽이었다. 12가지.

```
const github = {}                              // 클라이언트 자체를 가림
const upd = github.rest.pulls.update; upd({base:"main"})
github.rest["pulls"]["update"]({base:"main"})   // 계산된 멤버 접근
github.request("PATCH /repos/.../pulls/...")    // github.rest.* 를 아예 우회
{ ...{base:"main"}, owner, ... }                // 스프레드로 인자 주입
graphql에 updatePullRequest 추가
Object.assign(pr.base, {ref: EXPECTED_BASE})    // 점 대입이 아님
const b = pr.base; b.ref = ...                  // 별칭
const { base } = pr; base.ref = ...             // 구조분해
if (false) { ...전체... }
try { ...전체... } catch {}                      // 실패를 삼킴
return;                                         // 조기 반환
```

### 인정할 것은 인정한다

감사 결론이 맞다. **JavaScript를 텍스트로 고정하는 건 이길 수 없다.** 같은 효과를
내는 철자가 무한히 많고, 정규식이 찾는 문자열은 전부 그대로 남는다. 정적 고정을
더 정교하게 만드는 방향은 5라운드에서 또 뚫린다.

그래서 읽기를 그만두고 **실행**한다.

### tests/helpers/enforce-pr-target-harness.ts

워크플로의 인라인 스크립트를 뽑아내 `actions/github-script`와 같은 자유 변수
(`github`, `context`, `core`, …)로 컴파일하고, 기록하는 가짜 클라이언트를 넘긴다.
`github-script`가 본문을 async 함수로 감싸므로 하네스도 똑같이 감싼다 — 스크립트가
최상위 `return`을 쓰기 때문에 이게 맞아야 조기 반환 경로가 재현된다.

`github.rest.*`뿐 아니라 `github.request`, `github.graphql`, `github.paginate`도
전부 같은 `record()`를 통과한다. 그래서 `github.rest.*`를 버린 재작성도 기록에 남는다.
`exec`/`io`/`fetch`/`require`는 접근만 해도 던지는 프록시로 막았다.

### 무엇을 검증하나

시나리오 7개를 실제로 돌린다.

| 시나리오 | 관찰하는 것 |
| --- | --- |
| dev 대상 PR | 읽기 2회뿐. 쓰기가 하나라도 생기면 목록에 나타난다 |
| main 대상 PR | 코멘트 → 제목 → draft 순서, `pulls.update` 인자가 정확히 4개, GraphQL은 `convertPullRequestToDraft` 하나 |
| 이미 draft인 PR | draft 변환 없음, 상태에 `autoDraftedByBot:false`, 리타깃 후에도 draft 유지 |
| 리타깃된 PR | 접두사 제거 + ready 복귀 + 코멘트 상태 `active:false` |
| 기여자가 제목을 더 고친 경우 | 접두사만 떼고 나머지 편집 보존 |
| 재실행 | 접두사 중복 부착 없음, 재-draft 없음 |
| GraphQL 실패 | 예외가 전파된다 (`try/catch` 삼킴 탐지), 상태 코멘트는 이미 나감 |

호출이 어떤 철자로 쓰였는지는 상관없다. 나온 호출을 본다.

## 변이 검증 실측 (39/39)

4라운드 스크립트 변이 12가지:

```
shadow-github CAUGHT     shadow-context CAUGHT    alias-update CAUGHT
spread-injection CAUGHT  computed-member CAUGHT   github-request CAUGHT
graphql-retarget CAUGHT  object-assign-pr CAUGHT  alias-pr-base CAUGHT
destructure-pr CAUGHT    early-return CAUGHT      if-false-wrap CAUGHT
try-catch-wrap CAUGHT
```

이전 27가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `23 pass  0 fail  344 expect() calls`, `bun run typecheck` 오류 0.

## 감사 5라운드 — 하네스 자체가 공격면이 된다

실행 하네스를 감사에 넘겼다. 또 FAIL. 이번 지적은 성격이 다르다. 스크립트를 뚫은 게
아니라 **가짜가 진짜와 다른 지점**을 찾았다.

| 변이 | 하네스의 어떤 거짓말을 이용했나 |
| --- | --- |
| `if (typeof exec === "function") return;` | `exec`을 Proxy 객체로 줬다. 진짜는 함수다 |
| `if (!process.versions.bun) return;` | 테스트는 Bun, `github-script`는 Node |
| `Object.assign(pr, context.payload.pull_request)` | `context.payload.pull_request`가 `pr`의 얕은 복사라 `base`가 **같은 객체**였다. 실제로는 이벤트 페이로드가 stale하다 |
| `paginate` → 단일 `listComments` | 가짜 paginate가 한 페이지만 읽었다 |
| `const u = await update(...); if (u) return;` | 가짜 쓰기가 `undefined`를 반환했다. Octokit은 응답 객체를 준다 |
| `if (botComment && !storedState) return;` | 손상된 JSON 상태 분기를 커버하는 시나리오가 없었다 |

전부 프로덕션에서는 동작이 달라지고 테스트에서는 초록인 변이다. 오라클이 거짓말하면
그 위에 쌓은 증거는 값어치가 없다.

### 하네스 수정

- `exec`/`glob`/`io`/`fetch`/`require`를 **호출 가능한** Proxy로 바꿨다. 진짜처럼
  함수지만 실제로 호출하면 던진다 — 이 워크플로는 서브프로세스를 돌릴 이유가 없다.
- `process`를 Node로 보이게 섀도잉했다. `versions.node`, `GITHUB_ACTIONS=true`,
  runner 경로까지. 런타임 탐지가 두 환경을 구분하지 못한다.
- `context.payload.pull_request`를 `pr`과 **깊은 수준까지 독립**시키고,
  `eventPayload` 옵션으로 실제로 stale하게 만들 수 있게 했다.
- `paginate`가 모든 페이지를 순회하고, `listComments`가 `page` 인자를 존중한다.
  `commentPages`로 다중 페이지를 구성할 수 있다.
- 모든 쓰기가 Octokit 모양의 `{status, url, headers, data}`를 반환한다.

### 시나리오 3개 추가

- **stale 이벤트 페이로드**: 이벤트는 dev, 실제 PR은 main → 강제 적용된다.
  반대 방향(이벤트 main, 실제 dev)은 쓰기 0회.
- **봇 코멘트가 2페이지로 밀린 경우**: `listComments` 2회 호출, 기존 코멘트를
  찾아서 편집(중복 생성 0회).
- **손상된 상태 JSON**: 강제 적용은 그대로 진행되고, 코멘트는 제자리에서 복구되며,
  `core.warning`이 남는다.

## 변이 검증 실측 (46/46)

5라운드 7가지(파생 1건 포함):

```
detect-exec-fn CAUGHT        detect-bun-runtime CAUGHT   detect-node-runtime CAUGHT
stale-payload-overwrite CAUGHT drop-pagination CAUGHT    branch-on-response CAUGHT
bail-on-bad-state CAUGHT
```

이전 39가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `26 pass  0 fail  359 expect() calls`, `bun run typecheck` 오류 0.
전체 스위트(푸시 훅): `4907 pass  0 fail`.

## 감사 6라운드 — 전역 탈출, 에러 모양, 미커버 분기

5라운드 수정본을 다시 넘겼다. FAIL, 6건.

**전역 탈출 3건.** `compileScript`가 `new Function`을 쓰므로 컴파일된 본문이 전역
스코프를 본다. `process`를 파라미터로 넘겨 가려도 `globalThis.process`,
`Function("return process")()`, 그리고 `typeof Bun`은 진짜 런타임에 닿는다.
감사는 `if (typeof Bun === "undefined") return;`으로 프로덕션에서만 죽는 워크플로를
만들었다. 5라운드에서 `!process.versions.bun`을 막았더니 부정 방향으로 되받은 것이다.

**Octokit 에러 모양 1건.** `failOn`이 평범한 `Error`를 던졌다. 진짜는 `.status`를
가진 `RequestError`다. `catch (error) { if (error.status === 404) return; throw error; }`
— 404 하나만 삼키면 draft 변환 실패가 초록 워크플로가 된다.

**미커버 분기 2건.** `{active: true, titlePrefixedByBot: false, autoDraftedByBot: false}`은
도달 가능한 상태다(이미 접두사가 붙어 있고 이미 draft인 PR이 남긴다). 시나리오가
없어서, 이 조합에서 조기 반환하도록 양쪽 분기를 죽여도 초록이었다.

**느슨한 어설션 1건.** stale 페이로드 시나리오만 `toContain`을 썼다. 감사는 정확히
그 경로에 `github.request("POST /repos/attacker/other/issues")`를 매달았다.

### 대응

- 렉시컬 섀도잉 대상을 `RUNTIME_SHADOWS`로 확장했다: `process`, `globalThis`,
  `global`, `Bun`, `Deno`, `Function`, `eval`, `module`. `globalThis`는 자기 자신을
  가리키는 가짜 전역 객체로, 그 안의 `process`도 Node 모양이고 `Bun`은 undefined다.
  `Function`과 `eval`은 호출하면 던진다 — write 토큰을 쥔 워크플로가 런타임에 코드를
  컴파일할 이유는 없다.
- `failOn`이 `HttpError`(`.status`, `.response.status`)를 던진다. `failStatus`로
  코드를 지정할 수 있고, 테스트가 403/404/422/500을 순회한다.
- 시나리오 2개 추가: 변경 기록이 없는 활성 상태에서 (a) 여전히 잘못된 대상,
  (b) 리타깃 완료 — 양쪽 다 상태가 정리돼야 한다.
- stale 경로 어설션을 정확한 동등 비교로 바꿨다.

## 변이 검증 실측 (53/53)

6라운드 7가지:

```
detect-bun-absent CAUGHT   globalthis-process CAUGHT  function-escape CAUGHT
swallow-404 CAUGHT         noop-active-wrong CAUGHT   noop-active-correct CAUGHT
cross-repo-on-stale CAUGHT
```

이전 46가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `28 pass  0 fail  376 expect() calls`, `bun run typecheck` 오류 0.

## 여섯 라운드가 남긴 것

설계가 세 번 바뀌었고, 매번 앞 라운드가 그 방향의 한계를 증명했다.

1. **부정 목록** (1~3라운드) — "이 키는 없어야 한다". 20번 뚫렸다. 감사자가 생각해낸
   키만 덮는다.
2. **허용 목록** (4라운드) — "정확히 이 키들". YAML 골격에는 유효했고 지금도 유지된다.
   하지만 스크립트 본문에는 통하지 않았다. JavaScript는 같은 효과에 무한한 철자가 있다.
3. **실행 하네스** (5~6라운드) — 읽지 말고 돌려라. 철자는 무의미해졌지만, 이번엔
   **가짜의 충실도**가 새 공격면이 됐다. 두 라운드 연속으로 스크립트가 아니라
   하네스가 뚫렸다.

세 번째가 옳은 방향이다. 다만 오라클의 충실도가 곧 증거의 품질이다. 앞으로 이
하네스를 손댈 때 물어야 할 질문은 하나다 — **진짜 `github-script` + Octokit이라면
어떻게 행동하나.** 다르게 행동하는 지점이 곧 다음 우회다.

## 범위 밖

게이트 자체의 재설계는 040이 다루며 사용자 승인 대기 상태다. 이 테스트는 재설계를
막지 않는다 — 재설계가 어떤 성질을 의도적으로 바꾸는지 드러낼 뿐이다.
