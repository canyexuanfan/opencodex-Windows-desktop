# 010 — dev2-go 통합선 문서화 + 포팅/리베이스 PR 환영 (rev4, 문서 전용)

WP2 · 근거: `000_survey.md`
감사 이력: rev1 FAIL(`011`) → rev2 FAIL(`012`) → rev3 FAIL(`013`)

## 이 문서의 범위 (rev4에서 축소됨)

세 번의 감사가 전부 `enforce-pr-target.yml` 재설계에서 막혔다. 그래서
요구사항을 두 층으로 분리했다 (`013_audit_round3_and_scope_split.md`):

- **층 1 — 정책 선언.** 이 문서. 문서 3개만 고친다.
- **층 2 — 자동화 게이트.** `020_pr_target_gate.md`(WP5)로 분리. 보안 경계
  변경이고 main 승격이 필요하며 사용자 승인 대기 상태다.

**따라서 이 work-phase를 완료해도 dev2-go PR은 여전히 `[WRONG BRANCH]`
접두사와 강제 draft를 받는다.** 이건 숨길 사실이 아니라 문서에 적을
사실이다 — 정책이 자동화보다 먼저 서는 것은 정상 순서다.

## 채택 모델

"동등한 두 통합 브랜치"가 아니라 **주 통합선 + 범위가 정해진 병렬 통합선**.

- `dev` — 기본값. 별도 이유가 없는 모든 PR.
- `dev2-go` — Go 네이티브 포트 범위 작업 (`go/`, 네이티브 런타임 진입점,
  Go 릴리스 자산 도구).

근거: `origin/dev`는 `origin/dev2-go`의 조상이고(역방향 커밋 0), dev2-go는
334커밋 앞서 있으며 전용 추가 파일 901개 중 810개가 `go/` 아래다. 임시
브랜치가 아니라 장기 병렬 개발선이다.

## 변경 1 — `AGENTS.md`

### 1-1. Branch policy (41행 부근)

현재:

    - `dev` — integration branch. All normal pull requests target `dev`.
    - `main` — release branch. ...
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

변경 후:

    - `dev` — integration branch and the default target. A pull request goes
      here unless it belongs to a scoped line below.
    - `dev2-go` — parallel integration line for the Go native port: `go/`,
      `bin/native-runtime.mjs`, `src/lib/runtime-entry.ts`, and the Go
      release-asset tooling. Pull requests confined to that surface may target
      it directly. Note that the target-branch check has not caught up yet: it
      prefixes any non-`dev` pull request with `[WRONG BRANCH]` and converts it
      to a draft, and it re-applies both on the next `edited` or
      `ready_for_review` event — so clearing them by hand does not stick. Until
      the check is updated, treat that state as cosmetic noise on a `dev2-go`
      pull request rather than a defect in the contribution.
    - `main` — release branch. It only moves by maintainer-controlled promotion
      from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

claudedesktop 문단 뒤에 추가:

    Porting and rebase pull requests are welcome. Forward-porting a fix from
    one integration line to another, or rebasing a stale branch onto the
    current head, is ordinary maintenance rather than noise — open it as a
    normal pull request and name the source commits in the description.

### 1-2. Review guidelines / Branch targeting (63행 부근)

현재:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      `dev` (releases and maintainer promotions are the only exceptions).

변경 후:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      an integration branch (releases and maintainer promotions are the only
      exceptions). `dev` is the default; `dev2-go` is legitimate for work
      confined to the Go native-port surface. Do not flag a `dev2-go` pull
      request merely for not targeting `dev`, and do not treat the automated
      `[WRONG BRANCH]` prefix on such a PR as the author's mistake.

마지막 절이 중요하다. 자동화가 제목을 고쳐 쓰기 때문에, 그걸 본 리뷰어가
작성자를 탓하는 일이 실제로 있었다 (PR #455).

## 변경 2 — `CONTRIBUTING.md` (13-16행)

현재:

    - `dev` — integration target for all normal pull requests.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

변경 후:

    - `dev` — default integration target for pull requests.
    - `dev2-go` — parallel integration line for the Go native port. Target it
      when your change is confined to `go/`, the native runtime entrypoint, or
      the Go release-asset tooling. The automated target-branch check does not
      know about this line yet, so it will prefix your PR title with
      `[WRONG BRANCH]` and convert it to a draft — and it will do so again if
      you edit the title or mark the PR ready. That is expected for now and is
      not a judgement on your change; a maintainer reviews and merges it
      regardless. You do not need to retarget.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

    Porting and rebase pull requests are welcome: carrying a fix across
    integration lines, or rebasing a stale branch onto the current head, is
    normal contribution. Note the source commits in the description.

기여자 대상 문서이므로 "무슨 일이 벌어지고 어떻게 되는지"를 가장 구체적으로
쓴다. 놀라지 않게 하는 것이 목적이다.

## 변경 3 — `MAINTAINERS.md` (18행)

현재:

    - Normal pull requests target `dev`.

변경 후:

    - Pull requests target `dev` by default. `dev2-go` is a parallel
      integration line reserved for Go native-port work; it converges back
      through maintainer-controlled merges, and promotion to `main` still
      happens only from `dev`. Until the target-branch check recognises that
      line, `dev2-go` pull requests carry an automated `[WRONG BRANCH]` prefix
      and draft state that re-applies on every `edited` / `ready_for_review`
      event; clearing it by hand does not hold, so review and merge such pull
      requests in that state rather than trying to fix the label first.

## 범위 밖

- **워크플로 변경 전부** — `020_pr_target_gate.md`(WP5). 사용자 승인 대기.
- `ci.yml` / `service-lifecycle.yml`의 `dev2-go` 추가 — 층 2에 포함.
  (dev에 넣어도 base=dev2-go PR에는 적용되지 않는다. 그쪽 브랜치 작업이다.)
- `docs-site/` 5개 로케일 기여 페이지 — branch policy 섹션 자체가 없어
  모순이 생기지 않는다.

## 수용 기준

1. `rg -n "dev2-go" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 각 파일 1건 이상.
2. `rg -n -i "porting|rebase" AGENTS.md CONTRIBUTING.md` — 환영 문구 매치.
3. `rg -n "WRONG BRANCH" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 세 파일
   모두 현재 자동화 동작을 명시한다 (사실을 숨기지 않았다는 반증).
4. `git diff --name-only` 에 `.github/` 경로가 **없다** (층 분리 반증).
5. 최종 보고에 "자동화는 아직 미변경, dev2-go PR은 여전히 draft로 강등됨"이
   명시된다.
