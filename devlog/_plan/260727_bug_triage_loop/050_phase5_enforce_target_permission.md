# 050 — WP4: `enforce-pr-target.yml` 권한 결함

발견: WP0 트리아지(`002`), 원인 확정: WP3 감사
대상 파일: `.github/workflows/enforce-pr-target.yml`

## 증상

잘못된 base를 겨냥한 **ready 상태** PR에서 `enforce-target` 잡이 실패한다.

```
run 30240509333 (feat/glm-provider)
GraphqlResponseError: Request failed due to following response errors:
 - Resource not accessible by integration
##[error]Unhandled error: GraphqlResponseError
response: { data: { convertPullRequestToDraft: null }, errors: [ [Object] ] }
```

## 원인

워크플로는 잘못된 base를 발견하면 세 가지를 한다.

1. 설명 코멘트를 upsert (REST) — 성공
2. 제목에 `[WRONG BRANCH] ` 접두사 (REST `pulls.update`) — 성공
3. `convertPullRequestToDraft` (GraphQL) — **실패**

`permissions:`는 `pull-requests: write`만 부여하는데 draft 전환에는 부족하다. 그리고
워크플로에 `try`/`catch`도 `core.setFailed`도 없어서 **처리되지 않은 예외가 잡 전체를
죽인다.**

실측 확증(WP0 시점):

| PR | 제목 접두사 | draft 전환 |
|----|-------------|------------|
| #527 | 붙음 | 실패 (`isDraft: false`) |
| #536 | 붙음 | 실패 (`isDraft: false`) |

REST는 되고 GraphQL만 안 되는 비대칭이 원인을 그대로 보여준다.

## 발화 조건 (WP3 감사에서 좁힘)

"잘못된 타깃 전부"가 아니다. **`!pr.draft`일 때만** `convertToDraft()`가 호출된다
(`enforce-pr-target.yml`, wrongBase 분기 말미). 따라서:

| 상태 | 결과 |
|------|------|
| ready + 허용 안 된 base | **실패** |
| draft + 허용 안 된 base | 통과 (뮤테이션 스킵) |
| 허용된 base | 통과 (분기 자체 미진입) |

실측: #536이 `dev`로 리타깃된 뒤 `feat/glm-provider` 실행(`30250881926`,
`30250880040`)이 **success**다.

## 2차 결함: 상태 손상으로 복원이 영구 차단된다

더 심각한 문제가 있다. 워크플로는 PR을 바꾸기 **전에** 상태를 코멘트에 저장한다:

```js
if (!pr.draft) {
  state.autoDraftedByBot = true;     // "내가 draft로 만들었다"고 기록
}
...
await upsertComment([... stateMarker(state) ...]);   // 먼저 저장
...
if (!pr.draft) {
  await convertToDraft();            // 그 다음 실행 — 여기서 죽는다
}
```

주석은 "API 요청이 중간에 실패해도 재실행으로 복구할 수 있게" 먼저 저장한다고 설명한다.
의도는 옳지만 결과는 반대다. `autoDraftedByBot: true`가 기록됐는데 전환은 실패했으므로,
**기록된 상태와 실제 PR 상태가 어긋난다.**

나중에 작성자가 base를 고치면 복원 경로가 이렇게 판단한다:

```js
if (storedState.autoDraftedByBot && pr.draft) {
  await markReadyForReview();
}
```

`autoDraftedByBot`은 `true`지만 `pr.draft`는 `false`(전환이 실패했으니)이므로 조건이
거짓이다. 다행히 이 경우엔 아무 일도 안 일어나고 PR은 이미 ready이므로 실질 피해가 없다.

**실측으로 확인.** #536이 `dev`로 리타깃된 뒤:

```
state: {"version":1,"active":false,"autoDraftedByBot":false,"titlePrefixedByBot":false}
"✅ Target branch corrected" / 제목 접두사 제거됨 / draft=false
```

복원이 정상 동작했다. 즉 2차 결함은 이 경로에서는 자기 치유된다.

반대 방향이 위험하다. 만약 draft 전환이 **성공**한 뒤 다른 단계가 실패하면
`autoDraftedByBot`이 기록되지 않은 채 PR만 draft가 되어, 복원이 영원히 ready로
되돌리지 않는다. 현재 권한으로는 전환 자체가 늘 실패하므로 이 시나리오는 발생하지
않지만, 권한만 넓히고 오류 처리를 안 하면 그때 드러난다.

## 수정 방향 — 두 갈래

### A. 권한을 넓힌다

`permissions:`에 draft 전환에 필요한 스코프를 추가한다.

- 장점: 원래 의도(잘못된 타깃 PR을 draft로 내려 리뷰 대기열에서 빼기)가 살아난다.
- 단점: **워크플로 권한 상승은 `AGENTS.md`상 릴리스 블로커급 보안 검토 대상이다.**
  `pull_request_target` 트리거이므로 fork PR의 컨텍스트에서 돈다. 권한을 넓히면
  공격 표면이 커진다.

### B. 실패를 우아하게 처리한다 (권장)

draft 전환을 `try`/`catch`로 감싸고, 실패해도 잡을 죽이지 않는다.

```js
let drafted = false;
if (!pr.draft) {
  try {
    await convertToDraft();
    drafted = true;
  } catch (error) {
    core.warning(`Could not convert to draft: ${error.message}`);
  }
}
state.autoDraftedByBot = drafted;   // 실제 결과를 기록
```

상태를 **실제 결과로** 기록하려면 코멘트 저장을 전환 뒤로 옮겨야 한다. 그러면 주석이
말하는 "부분 실패 복구" 의도가 깨지므로, 대안은 두 번 저장하는 것이다: 먼저 보수적으로
저장하고, 전환 결과가 나오면 갱신한다.

- 장점: 권한 상승 없음. 제목 접두사와 안내 코멘트는 계속 동작하므로 워크플로의
  주된 목적(작성자에게 알리기)은 유지된다. 체크가 녹색이 되어 진짜 실패와 구분된다.
- 단점: 잘못된 타깃 PR이 ready로 남는다. 다만 지금도 그렇다 — 전환이 늘 실패하므로
  동작상 차이가 없고, 거짓 실패만 사라진다.

## 권고

**B를 권장한다.** 지금 상태는 "기능은 안 되면서 체크만 빨간" 최악의 조합이다. B는
권한 상승 없이 그 거짓 신호를 없애고, 실제로 동작하는 부분은 그대로 둔다. A는 보안
검토를 요구하며, 그 검토는 이번 루프의 권한 범위 밖이다.

A를 택하더라도 B의 오류 처리는 함께 들어가야 한다. 그래야 위에서 말한 반대 방향
상태 손상이 막힌다.

## 이번 루프에서 구현하지 않는 이유

`.github/workflows/` 변경은 `AGENTS.md`가 명시적 보안 검토를 요구하는 범주다
(릴리스 자동화·워크플로 권한). 사용자가 승인한 범위는 `dev` 푸시(#539 수정)였고
워크플로 수정은 별도 결정이다. 판정과 수정 방향까지 문서화하고 실행은 보류한다.

## 검증 (구현 시)

워크플로는 로컬에서 실행할 수 없으므로 증거는 실제 실행으로만 얻는다.

1. ready 상태 + 허용 안 된 base인 테스트 PR을 만든다.
2. `enforce-target`이 **success**이고 제목 접두사와 안내 코멘트가 정상인지 확인한다.
3. base를 고친 뒤 접두사 제거와 상태 코멘트 갱신이 동작하는지 확인한다.
4. draft 상태 PR에서도 기존 동작이 유지되는지 확인한다.

`tests/ci-workflows.test.ts`가 워크플로 파일의 구조를 검증하므로, 경로 허용 목록과
권한 블록에 대한 단언이 있으면 함께 갱신한다.
