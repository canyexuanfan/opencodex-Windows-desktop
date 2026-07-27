# 002 — 열린 PR 트리아지 매트릭스

조사 시점: 2026-07-27, `dev` = `f327db1e`
대상: `gh pr list --state open` 17건

## UNSTABLE의 실제 의미

`mergeStateStatus=UNSTABLE`로 뜨는 PR 대부분은 테스트 실패가 아니다. fork PR의
Cross-platform CI / React Doctor 워크플로가 `conclusion=action_required` 상태로
승인 대기 중이라서다. 확인:

```
gh run list --json conclusion --jq '.[] | select(.conclusion=="action_required")'
  → fix/gui-update-install-failure-recovery (#533)  314eb53a
  → split/426-01-namespace-foundation      (#512)  aef5628f
  → feat/glm-provider                      (#536)  26e51840
  → feat/image-bridge                      (#424)  a8b769c9
  → feat/gemini-inline-image               (#355)  d3c876e6
```

즉 이 5건은 "CI 실패"가 아니라 "CI 미실행"이다. 승인은 메인테이너 권한 행위이며
이번 루프의 자동 실행 범위 밖이다 — 승인 자체가 fork 코드를 CI에서 실행시키는
결정이기 때문이다.

`enforce-target` FAILURE는 별개이고 실제 실패다: #536(→`main`), #527(→`codex/...` 스택).

## 매트릭스

| # | 제목 요약 | 성격 | 상태 | 판정 |
|---|-----------|------|------|------|
| 526 | sync가 실제로 카탈로그/캐시를 썼는지 보고 | 버그(#476) | CLEAN, CI 통과 | **MERGE-READY** — 신호만 추가, 소비자 없음. 저위험 |
| 527 | 카탈로그 쓰기 후 stale app-server 경고 | 버그(#476) | `enforce-target` FAIL | **BLOCKED-BY-STACK** — #526 머지 시 자동 해소. 그 전엔 리타깃 불가 |
| 529 | 아카이브 정리 + 격리 (phase 2 of #42) | 기능 | CLEAN, CI 통과 | **MERGE-READY** — 단 +3264/-21로 큼. 별도 리뷰 필요 |
| 528 | 이미지 브리지 P2 후속 | 버그 후속 | CLEAN | **BLOCKED-BY-DEP** — #424 의존. #424가 먼저 |
| 424 | Grok 이미지 브리지 | 기능 | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 355 | Gemini 인라인 이미지 출력 | 기능 | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 533 | npm 캐시 실패 시 프록시 보존 | 버그(실장애) | CI 미승인 | **NEEDS-SECURITY-REVIEW** — 의존성 설치 경계. 본문이 메인테이너 보안 리뷰를 명시 요청 |
| 512 | Codex 계정 네임스페이스 기반 | 기능(#425) | CI 미승인, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 536 | Zhipu GLM 프로바이더 | 기능 | `main` 타깃 → FAIL | **NEEDS-RETARGET** — 작성자가 `dev`로 변경해야 함 |
| 455 | 임시 검증 export 트리거 | 잡무 | DIRTY(충돌), +69609/-275 | **CLOSE-CANDIDATE** — 자기 소유 임시 draft. 목적 소멸 시 종결 대상 |
| 491 | OAuth 로그인이 저장된 API 키 삭제 방지 | 버그 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** — 보안 경계 |
| 493 | 계정별 Claude rate limit | 기능 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 495 | main 계정 최후 수단 예약 | 기능 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** |
| 498 | opt-in 네이티브 서브에이전트 기본값 | 기능 | draft, CHANGES_REQUESTED, +2427 | **NEEDS-AUTHOR** |
| 447 | Kiro 브라우저 멀티계정 로그인 | 버그 | draft, CHANGES_REQUESTED | **NEEDS-AUTHOR** — 인증 경계 |
| 429 | Cursor 셸 alias 힌트 주입 중단 | 버그 | draft | **NEEDS-AUTHOR** |
| 461 | `ocx opencode` 런처 | 기능 | draft | **NEEDS-AUTHOR** |

## 종결 가능 대상

엄밀히 이번 루프에서 닫을 수 있는 PR은 **#455 하나**다.

- 자기(`lidge-jun`) 소유이므로 타 기여자 작업을 가로채지 않는다.
- 제목이 스스로 `[WRONG BRANCH] chore: temporary verification export trigger`이고
  본문상 목적이 일회성 검증이다.
- DIRTY(충돌) 상태이고 +69609/-275라 머지 경로가 없다.
- `dev2-go` 타깃이며 해당 검증은 이미 종료됐다(WP3에서 재확인 필요).

나머지 16건은 닫으면 안 된다. draft + CHANGES_REQUESTED는 "작성자가 작업 중"이라는
뜻이지 "포기"가 아니다. 외부 기여자 PR을 메인테이너가 일방 종결하면 기여 의욕을
꺾는다.

## 머지 순서 판정

```
#526 (CLEAN, 신호만)
   └─→ #527 (머지 후 base가 dev로 정리되어 enforce-target 통과)

#424 (CI 승인 필요)
   └─→ #528 (tip 6d6b252에서 분기, #424 선행 필요)
```

#526→#527이 이번 루프에서 판정 가능한 유일한 스택이다. 다만 머지 자체는 메인테이너
결정이며, 사용자가 이번 루프에서 승인한 것은 `dev` 푸시(#539 수정)까지다. PR 머지는
별도 승인이 필요하다 — 판정과 문서화까지가 WP3의 범위다.

## 스코프 경계 기록

이번 루프에서 **하지 않는** 것과 그 이유:

- fork CI 승인: 승인은 fork 코드를 CI 러너에서 실행시키는 보안 결정이다.
- PR 머지: 사용자 승인 범위는 `dev` 푸시로 한정됐다.
- 타 기여자 PR 코드 직접 수정: `AGENTS.md` 리뷰 정책상 리뷰어의 역할은 지적이지 대필이 아니다.
