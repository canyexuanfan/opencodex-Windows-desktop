# 030 — WP3: PR 처분

근거: `002_pr_triage_matrix.md`

## 권한 경계 (먼저 확정)

이번 루프에서 사용자가 승인한 것은 **`dev` 푸시(#539 수정)** 한 건이다. 따라서:

| 행위 | 이번 루프에서 | 이유 |
|------|---------------|------|
| PR 판정 + 문서화 | **한다** | 사용자가 "트리아지하고 닫는 계획"을 요청 |
| 자기 소유 임시 PR 종결 | **한다** | 외부 기여자에게 영향 없음 |
| 타 기여자 PR 종결 | 하지 않는다 | draft+CHANGES_REQUESTED는 작업 중이라는 뜻 |
| PR 머지 | 하지 않는다 | 승인 범위 밖. 별도 승인 필요 |
| fork CI 승인 | 하지 않는다 | fork 코드를 CI 러너에서 실행시키는 보안 결정 |

## 실행 항목 1: #455 종결

대상: `[WRONG BRANCH] chore: temporary verification export trigger`

종결 근거:

- 소유자가 `lidge-jun`(자기 소유) — 외부 기여를 가로채지 않는다
- 제목과 본문이 스스로 일회성 임시 검증용임을 명시
- `mergeStateStatus=DIRTY` (충돌) + `+69609/-275` — 머지 경로가 없다
- `dev2-go` 타깃이며 해당 검증 목적은 종료됨

실행 전 확인: `dev2-go` 브랜치에서 이 export가 여전히 필요한지 재조회한다. 필요하면
종결하지 않고 판정을 뒤집는다.

코멘트 문안:

> Closing: this was a one-shot export trigger to verify the `dev2-go` release-asset
> path, and that verification is done. The branch is now conflicted against its base
> and carries a 69k-line diff that was never meant to merge. Reopen or re-trigger from
> a fresh branch if the export needs another run.

## 실행 항목 2: #526 → #527 스택 순서 판정

판정만 하고 머지하지 않는다.

```
#526  base=dev   head=1ba588ef   CLEAN, CI 통과, +86/-14
  └─ #527  base=codex/catalog-written-signal   head=a64aa585   enforce-target FAIL
```

#527의 `enforce-target` 실패는 그 자체로 결함이 아니다. `#526`의 head 브랜치를 base로
삼은 스택 PR이라 타깃 검사가 통합 브랜치(`dev`/`dev2-go`)가 아니라고 거부하는 것이다.
`#526`이 `dev`에 머지되면 GitHub가 `#527`의 base를 `dev`로 자동 재지정하고 검사는
통과한다.

따라서 권고 순서는 `#526` → `#527`이며, `#527`을 먼저 손대거나 리타깃을 요구하는 것은
불필요한 작업이다. 이 판정을 `#527`에 코멘트로 남긴다(머지는 하지 않음).

## 실행 항목 3: 버그성 PR의 결함 실재 여부 검증

"버그 수정 PR"이라고 주장하는 것들이 실제 결함을 고치는지 코드로 확인한다. 판정만 기록.

| PR | 주장하는 결함 | 검증 방법 |
|----|---------------|-----------|
| 526 | sync가 no-op인지 실제 쓰기인지 구분 불가 | `syncCatalogModels()` 현재 반환 타입 확인 |
| 533 | npm 캐시 EACCES 시 프록시가 정지된 채 방치 | 실장애 재현 기록 존재. 보안 리뷰 대상이라 판정만 |
| 429 | Cursor가 사용자 프롬프트에 셸 alias 힌트 주입 | 주입 코드 경로 존재 확인 |
| 447 | Kiro 멀티계정 브라우저 로그인 미지원 | 인증 경계 — 판정만 |
| 491 | OAuth 로그인이 저장된 API 키 삭제 | 인증 경계 — 판정만 |

보안 경계(인증/토큰/OAuth/의존성 설치)에 걸리는 것은 `MAINTAINERS.md`상 명시적 보안
리뷰 대상이다. 이번 루프는 "결함이 실재하는가"까지만 판정하고 머지 판단은 하지 않는다.

## 수용 기준

- 17건 전부가 분류되고 각 판정에 근거가 있다
- 실제 처분한 PR은 종결 근거 코멘트를 동반한다
- 처분하지 않은 PR은 왜 하지 않았는지가 기록된다
- 권한 경계를 넘은 행위가 0건이다
