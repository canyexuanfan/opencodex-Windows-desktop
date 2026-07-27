# 030 — @Wibias 메인테이너 추가 (diff-level)

WP4 · 근거: `000_survey.md`, `260727_overnight_triage/000_triage.md`

## 절차 요건

MAINTAINERS.md "Maintainer changes"가 세 가지를 요구한다:

1. 프로젝트 소유자의 동의
2. 가능한 경우 다른 현직 메인테이너의 리뷰
3. `MAINTAINERS.md`와 `.github/CODEOWNERS` **양쪽** 갱신

1번은 이 세션에서 사용자(@lidge-jun, 프로젝트 소유자)가 직접 지시했다
— "maintainer에 wibias추가". 2번은 @Ingwannu의 PR 리뷰로 충족하며,
이 변경을 PR로 올리면 CODEOWNERS 규칙상 자동으로 리뷰 요청이 간다
(`/MAINTAINERS.md @lidge-jun @Ingwannu`).

## 근거 (기여 실적)

v2.7.41 릴리스(2026-07-26T15:44Z) 이후 dev에 머지된 21개 PR 중 Wibias 저자:

- Kiro 스트리밍 안정화 전체 — #514, #516, #520 (이슈 #507/#508/#519 종료)
- UX paper cuts — #517 (이슈 #488 종료)
- combo 카탈로그 누락 — #516 (이슈 #484 종료)
- CI 이슈 번역 파이프라인 — #510, #513, #523
- GUI react-doctor 정리 — #468~#481 계열 다수
- 릴리스 노트 — #482

이슈 트리아지와 dev 통합 작업을 이미 사실상 수행하고 있다. 문서를
현실에 맞추는 변경이다.

## 변경 1 — `MAINTAINERS.md`

현재 표:

    | GitHub account | Project role | Responsibilities |
    | --- | --- | --- |
    | [@lidge-jun](https://github.com/lidge-jun) | Project owner | Project direction, releases, repository administration, and final governance decisions |
    | [@Ingwannu](https://github.com/Ingwannu) | Maintainer | Issue and pull-request triage, `dev` integration, security review, and repository maintenance |

추가할 행 (@Ingwannu 아래):

    | [@Wibias](https://github.com/Wibias) | Maintainer | Issue and pull-request triage, `dev` integration, provider and CI maintenance |

책임 문구를 @Ingwannu와 다르게 쓴 이유: 보안 리뷰는 기존 두 명이
계속 맡는다. 실제 기여 이력이 프로바이더(Kiro/combo)와 CI 파이프라인에
집중되어 있어 그대로 반영했다. 보안 경계를 자동으로 넓히지 않는 것이
이 변경의 안전 설계다.

## 변경 2 — `.github/CODEOWNERS`

현재:

    # Default reviewers
    * @lidge-jun @Ingwannu

    # Repository automation and release security
    /.github/ @lidge-jun @Ingwannu
    /scripts/release.ts @lidge-jun @Ingwannu
    /package.json @lidge-jun @Ingwannu
    /bun.lock @lidge-jun @Ingwannu

    # Authentication, credentials, and management API
    /src/oauth/ @lidge-jun @Ingwannu
    /src/codex/auth-context.ts @lidge-jun @Ingwannu
    /src/server/auth-cors.ts @lidge-jun @Ingwannu
    /src/server/management-api.ts @lidge-jun @Ingwannu

    # Governance and security policy
    /MAINTAINERS.md @lidge-jun @Ingwannu
    /SECURITY.md @lidge-jun @Ingwannu

변경 후 — **기본 리뷰어에만** 추가하고 보안 경로는 건드리지 않는다:

    # Default reviewers
    * @lidge-jun @Ingwannu @Wibias

    (이하 모든 경로 블록은 그대로 유지)

CODEOWNERS는 나중 규칙이 앞 규칙을 덮어쓴다. 기본 리뷰어에만 추가하면
일반 코드는 세 명이 리뷰 대상이 되고, `/src/oauth/`, `/.github/`,
`/scripts/release.ts`, `/MAINTAINERS.md`, `/SECURITY.md` 같은
보안·릴리스 경계는 여전히 기존 두 명만 소유한다.

이건 의도적이다. MAINTAINERS.md가 "authentication, credential handling,
GitHub Actions, release automation ... require explicit security review"라고
규정하므로, 메인테이너 추가와 보안 경계 확대는 별개의 결정이어야 한다.
보안 경로까지 넓히려면 소유자가 따로 지시해야 한다.

### 다만 CODEOWNERS는 강제가 아니다 (감사 지적)

`*` 규칙에만 추가해도 뒤쪽 경로 규칙이 우선한다는 점은 GitHub 문서로
확인됐다(마지막 매치 우선). 그러나 실제 브랜치 보호는 없다:

    gh api repos/lidge-jun/opencodex/branches/dev/protection    # HTTP 404
    gh api repos/lidge-jun/opencodex/branches/main/protection   # HTTP 404

즉 CODEOWNERS는 **리뷰 요청 자동화일 뿐 승인 강제가 아니다.** "보안 경로를
CODEOWNERS로 지켰다"고 말하면 과장이다. 실제 강제가 필요하면 브랜치 보호
규칙에 "Require review from Code Owners"를 켜야 하고, 그건 저장소 관리자
설정이라 문서 변경으로는 불가능하다.

## 변경 3 — 절차 이행 기록

MAINTAINERS.md "Maintainer changes" 절 아래에 이력 문단을 추가한다:

    ### Change log

    - 2026-07-27 — @Wibias added as a maintainer. Requested by the project
      owner; scope covers issue and pull-request triage, `dev` integration,
      and provider/CI maintenance. Security-boundary ownership in
      `.github/CODEOWNERS` is unchanged.

이유: 절차가 "소유자 동의 + 다른 메인테이너 리뷰"를 요구하는데, 그 동의가
어디에 남는지 문서에 없다. PR 승인 기록은 GitHub에만 있고 저장소를
클론하면 사라진다. 한 줄 이력이 그 공백을 메운다.

## 범위 밖

- 보안·릴리스 경로 CODEOWNERS 확대 (별도 소유자 결정 필요)
- GitHub 저장소 권한 설정 변경 — MAINTAINERS.md가 명시하듯
  "Actual repository permissions remain controlled through GitHub
  repository settings"이고, 이건 저장소 관리자만 할 수 있다.
  **문서 변경만으로 실제 권한이 생기지 않는다는 점을 사용자에게 보고한다.**

## 수용 기준

1. `rg -n "Wibias" MAINTAINERS.md` → 표 행 + change log 두 군데 매치.
2. `rg -n "Wibias" .github/CODEOWNERS` → 기본 리뷰어 행 1건만 매치.
3. `rg -n "@Wibias" .github/CODEOWNERS | rg -c "oauth|release|SECURITY"` → 0.
   (보안 경로에 안 들어갔다는 반증)
4. MAINTAINERS.md 표가 3행이 된다.
