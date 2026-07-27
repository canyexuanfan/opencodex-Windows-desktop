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

## 범위 밖

게이트 자체의 재설계는 040이 다루며 사용자 승인 대기 상태다. 이 테스트는 재설계를
막지 않는다 — 재설계가 어떤 성질을 의도적으로 바꾸는지 드러낼 뿐이다.
