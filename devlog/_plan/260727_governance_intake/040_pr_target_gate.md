# 040 — PR 타깃 게이트 재설계 (WP5, 사용자 승인 대기)

분리 근거: `013_audit_round3_and_scope_split.md`
상태: **BLOCKED — 사용자 승인 필요**

## 왜 별도 work-phase인가

세 번의 독립 감사가 세 개의 서로 다른 우회를 찾아냈다:

| 설계 | 우회 |
| --- | --- |
| 경로 정규식 + `some()` | 범위 파일 1개로 임의 변경 통과 |
| 전량 검사 + 공유 경로 | rename(`previous_filename` 미검사), 3000파일 API 상한, 공유 디렉터리 과다 |
| 메인테이너 라벨 면제 | 라벨은 **triage 권한**이면 부여 가능, 승인 후 force-push 재검증 없음 |

`enforce-pr-target.yml`은 `pull_request_target` 트리거 + 저장소 write
토큰으로 도는 보안 경계 파일이다. MAINTAINERS.md상 GitHub Actions 변경은
명시적 보안 리뷰 대상이다.

게다가 실제 발효는 **main 승격 시점**이다 — `pull_request_target`은 기본
브랜치의 워크플로를 실행하고, 기본 브랜치는 `main`이다. main 승격은
사용자 승인 사항이다.

두 가지가 겹친다: 설계가 세 번 뚫렸고, 배포가 승인 대기다. 그래서
정책 문서(WP2)와 분리했다.

## 최소 요건 (3차 감사 제시)

1. **actor 검증.** 라벨을 승인 신호로 쓸 거면 누가 붙였는지 확인해야 한다.
   `github.event.sender`와 maintainer allow-list 대조, 또는 라벨 대신
   메인테이너 리뷰 승인(`pulls.listReviews`) 사용.

       gh api repos/lidge-jun/opencodex/collaborators --jq '.[] | "\(.login) triage=\(.permissions.triage) maintain=\(.permissions.maintain)"'
       # Wibias    triage=true maintain=false
       # Ingwannu  triage=true maintain=true
       # lidge-jun triage=true maintain=true

   triage와 maintain이 갈린다. 라벨만으로는 이 경계를 못 만든다.

2. **head SHA 바인딩.** 승인 시점의 head SHA를 기록하고, `synchronize`에서
   현재 SHA와 비교해 다르면 승인을 무효화한다. 그렇지 않으면 승인 후
   force-push로 내용을 통째로 바꿔도 통과한다.

3. **라벨 선행 생성.** `scope: dev2-go`는 현재 존재하지 않는다
   (`gh api .../labels/scope%3A%20dev2-go` → 404). 워크플로 배포 전에
   만들어야 한다.

## 추가로 필요한 것

4. **회귀 테스트.** `tests/ci-workflows.test.ts`에 `enforce-pr-target`
   테스트가 **하나도 없다**. 상태 전이(차단 → 승인 → 복구 → 승인 취소)를
   덮는 테스트가 없으면 이 워크플로는 다시 뚫린다.

5. **CI 커버리지 (dev2-go 브랜치 작업).** `pull_request` 워크플로는 PR의
   base 브랜치 버전이 실행되므로, dev2-go PR의 CI는 dev2-go에서 고쳐야 한다:

       dev2-go의 ci.yml               → branches: [main, dev, dev2-go]
       dev2-go의 service-lifecycle.yml → 동일
       dev2-go의 go-ci.yml            → pull_request 트리거 추가 (현재 push만)

## 전제 사실 (재확인 필요)

이 저장소에는 **브랜치 보호도 ruleset도 없다**:

    gh api repos/lidge-jun/opencodex/branches/dev/protection   # 404
    gh api repos/lidge-jun/opencodex/branches/main/protection  # 404
    gh api repos/lidge-jun/opencodex/rulesets                  # (없음)

따라서 CODEOWNERS든 라벨이든 **권한 강제가 아니라 운영 신호**다. 게이트를
"보안 통제"라고 부르려면 브랜치 보호부터 켜야 하고, 그건 저장소 관리자
설정이다.

이 사실이 설계 선택을 바꾼다: 강제할 수 없는 것을 정교하게 만드는 것보다,
명확한 신호를 주고 사람이 판단하게 하는 편이 정직하다.

## 승인이 필요한 결정

사용자에게 물어야 할 것:

1. 게이트를 자동 판정으로 갈 것인가, 아니면 **아예 dev2-go를 예외 목록에
   넣고 사람이 리뷰에서 거르게** 할 것인가? (후자는 코드 3줄이고 뚫릴
   표면이 없다. 대신 잘못된 base를 자동으로 못 잡는다.)
2. main 승격을 언제 할 것인가? 승격 없이는 어떤 설계도 발효되지 않는다.
3. 브랜치 보호를 켤 것인가? 켜지 않으면 이 게이트는 권고에 머문다.

## 상태

`NEEDS_HUMAN`. 위 세 결정 없이는 설계를 확정할 수 없고, 확정해도 배포할 수
없다.
