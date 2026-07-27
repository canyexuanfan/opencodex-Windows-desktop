# 010 — dev2-go 기반 PR 허용 + 포팅/리베이스 PR 환영 (diff-level, rev3)

WP2 · 근거: `000_survey.md`
감사 이력: 1차 FAIL → `011_audit_round1.md` · 2차 FAIL → `012_audit_round2.md`

## 발효 조건 (먼저 읽을 것)

`enforce-pr-target.yml`은 `pull_request_target` 트리거를 쓴다. GitHub은 이
트리거에 대해 **기본 브랜치(main)의 워크플로**를 실행하고, 이 저장소의
기본 브랜치는 `main`이다.

    gh repo view lidge-jun/opencodex --json defaultBranchRef   # main

따라서 `dev`에 커밋해도 **PR 판정 동작은 바뀌지 않는다.** dev2-go PR은
main 승격 전까지 계속 `[WRONG BRANCH]` 접두사와 강제 draft를 받는다.
main 승격은 사용자 승인 사항이며 이 goal의 범위 밖이다.

**이 한계는 최종 보고에 반드시 포함한다.**

## 설계: 정규식 판정이 아니라 라벨 면제

두 번의 감사에서 같은 뿌리의 결함이 반복됐다. 처음에는 "파일 하나라도
매치하면 통과"가 우회 가능했고, 전량 검사로 바꾸자 rename 우회
(`previous_filename` 미검사), 3,000 파일 API 상한, 공유 디렉터리 과다 허용이
연달아 나왔다.

공통 원인은 하나다: **파일 목록으로 기여자의 의도를 추론하려 한 것.**
그래서 추론을 포기하고 판정 주체를 사람으로 옮긴다.

    이전: 허용 정규식으로 통과시킨다 (뚫리면 통과 — fail-open)
    이후: 메인테이너 라벨로 면제한다 (라벨 없으면 차단 — fail-closed)

라벨은 저장소 write 권한자만 붙일 수 있으므로, 기여자가 스스로 우회할 수
없다. 그리고 워크플로가 PR 파일을 읽지 않으므로 rename·상한·공유경로 문제가
설계상 존재하지 않는다.

`pull_request_target`은 기본 저장소의 write 토큰으로 돈다. 여기서 하는 일이
적을수록 좋다.

## 변경 1 — `.github/workflows/enforce-pr-target.yml`

### 1-1. 상수

현재 (26행):

    const EXPECTED_BASE = "dev";
    const TITLE_PREFIX = "[WRONG BRANCH] ";

변경 후:

    const DEFAULT_BASE = "dev";

    // Parallel integration lines. A PR may target one of these only when a
    // maintainer has applied the matching label: label application requires
    // repository write access, so a contributor cannot grant it to themselves.
    //
    // An earlier revision tried to infer eligibility from the changed-file
    // list. Two audits broke it: renames are invisible unless you also read
    // `previous_filename`, the files API caps at 3000 entries, and any
    // directory broad enough to be useful (docs/, structure/) was broad enough
    // to smuggle unrelated changes. Inferring intent from paths is the wrong
    // tool; a human deciding once is the right one.
    const SCOPED_BASE_LABELS = {
      "dev2-go": "scope: dev2-go",
    };

    const TITLE_PREFIX = "[WRONG BRANCH] ";

### 1-2. 판정

현재 (156행):

    const wrongBase = pr.base.ref !== EXPECTED_BASE;

변경 후:

    function baseIsAllowed() {
      if (pr.base.ref === DEFAULT_BASE) return true;
      const required = SCOPED_BASE_LABELS[pr.base.ref];
      if (!required) return false;
      // pr is re-fetched at the top of this script, so labels are current.
      return (pr.labels ?? []).some(label => label.name === required);
    }
    const wrongBase = !baseIsAllowed();

기존 코드가 이미 스크립트 시작부에서 `github.rest.pulls.get`으로 PR을 다시
읽으므로 라벨은 최신이다. 새 API 호출이 없다.

### 1-3. 트리거

현재:

    types: [opened, reopened, edited, ready_for_review]

변경 후:

    types: [opened, reopened, edited, ready_for_review, labeled, unlabeled]

`labeled`/`unlabeled`가 필요한 이유: 메인테이너가 라벨을 붙이는 순간
재판정되어 제목 접두사와 draft 상태가 복구되어야 한다. 라벨을 떼면 다시
차단되어야 한다.

`synchronize`는 **넣지 않는다.** 판정이 파일 목록에 의존하지 않으므로
push마다 재판정할 이유가 없고, `pull_request_target`에서 트리거를 늘리는
것은 그 자체로 표면 확대다.

### 1-4. 안내 문구

현재는 base가 무엇이든 "must target `dev`"라고만 말한다. 두 갈래로 나눈다:

    // (a) scoped base인데 라벨이 없는 경우
    `This pull request targets ${inlineCode(pr.base.ref)}, a parallel
     integration line reserved for the Go native port. A maintainer applies the
     ${inlineCode(SCOPED_BASE_LABELS[pr.base.ref])} label once the scope is
     confirmed, and this check then clears automatically. If your change is not
     part of that port, retarget it to \`dev\`.`

    // (b) 그 외 (main 등) — 기존 문구 유지

(a)가 중요하다. 현재 문구는 정당한 dev2-go 기여자에게 "잘못했으니 옮겨라"고
말한다. 새 문구는 무엇을 기다리면 되는지 알려준다.

### 1-5. 복구 문구

274행의 `This pull request now targets ${EXPECTED_BASE}.`는 `DEFAULT_BASE`
가정이 깨지므로 실제 base를 쓰도록 바꾼다:

    `This pull request now targets ${inlineCode(pr.base.ref)}.`

## 변경 2 — 라벨 생성

`scope: dev2-go` 라벨이 저장소에 존재해야 한다. 라벨 생성은 저장소 설정
작업이므로 `gh label create`로 별도 수행하고, 계획서에 명령을 남긴다:

    gh label create "scope: dev2-go" --repo lidge-jun/opencodex \
      --color 0E8A16 \
      --description "PR targets the dev2-go Go native-port integration line"

## 변경 3 — CI 커버리지 (dev2-go 브랜치 작업, 범위 밖)

`pull_request` 트리거 워크플로는 **PR의 base 브랜치 버전**이 실행된다.
따라서 `dev`의 `ci.yml`을 고쳐도 base=dev2-go PR에는 적용되지 않는다.

    git show origin/dev2-go:.github/workflows/ci.yml | sed -n 3,5p
    #   pull_request:
    #     branches: [main, dev]

필요한 변경은 **dev2-go 브랜치에서** 이뤄져야 한다:

- `dev2-go`의 `ci.yml` → `branches: [main, dev, dev2-go]`
- `dev2-go`의 `service-lifecycle.yml` → 동일
- `dev2-go`의 `go-ci.yml` → `pull_request` 트리거 추가 (현재 `push`와
  `workflow_dispatch`만)

이건 dev 작업이 아니므로 **이번 work-phase 범위 밖**이다. 후속 work-phase
또는 dev2-go 대상 PR로 처리한다.

단, `dev`의 `ci.yml`/`service-lifecycle.yml`에도 `dev2-go`를 추가한다 —
main 승격 시 정책이 일치하도록.

## 변경 4 — `AGENTS.md`

### 4-1. Branch policy (41행 부근)

    - `dev` — integration branch and the default target. A pull request goes
      here unless it belongs to a scoped line below.
    - `dev2-go` — parallel integration line for the Go native port (`go/`, the
      native runtime entrypoint, and the Go release-asset tooling). Pull
      requests may target it directly; a maintainer applies the
      `scope: dev2-go` label to confirm the scope, which clears the
      target-branch check.
    - `main` — release branch. (기존 유지)
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

claudedesktop 문단 뒤:

    Porting and rebase pull requests are welcome. Forward-porting a fix from
    one integration line to another, or rebasing a stale branch onto the
    current head, is ordinary maintenance rather than noise — open it as a
    normal pull request and name the source commits in the description.

### 4-2. Review guidelines / Branch targeting (63행 부근)

    - **Branch targeting:** flag any pull request that targets `main` instead of
      an integration branch (releases and maintainer promotions are the only
      exceptions). `dev` is the default; `dev2-go` is legitimate for Go
      native-port work carrying the `scope: dev2-go` label. Do not flag a
      labelled `dev2-go` PR merely for not targeting `dev`.

## 변경 5 — `CONTRIBUTING.md` (13-16행)

    - `dev` — default integration target for pull requests.
    - `dev2-go` — parallel integration line for the Go native port. You may
      target it directly; a maintainer confirms the scope with the
      `scope: dev2-go` label.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

    Porting and rebase pull requests are welcome: carrying a fix across
    integration lines, or rebasing a stale branch onto the current head, is
    normal contribution. Note the source commits in the description.

## 변경 6 — `MAINTAINERS.md` (18행)

    - Pull requests target `dev` by default. `dev2-go` is a parallel
      integration line reserved for Go native-port work; a maintainer confirms
      each such pull request with the `scope: dev2-go` label. It converges back
      through maintainer-controlled merges, and promotion to `main` still
      happens only from `dev`.

## 범위 밖

- **main 승격** — 워크플로 발효 조건이지만 사용자 승인 사항.
- **dev2-go 브랜치의 CI 트리거** — 별도 작업 (변경 3).
- `docs-site/` 5개 로케일 기여 페이지 — branch policy 섹션 자체가 없어
  모순이 생기지 않는다.

## 수용 기준

1. `rg -n "dev2-go" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 각 파일 1건 이상.
2. `rg -n -i "porting|rebase" AGENTS.md CONTRIBUTING.md` — 환영 문구 매치.
3. `rg -n "dev2-go" .github/workflows/ci.yml .github/workflows/service-lifecycle.yml`
   — 각 1건.
4. `enforce-pr-target.yml`에 `EXPECTED_BASE`가 없고 `SCOPED_BASE_LABELS`,
   `labeled`, `unlabeled`가 존재한다.
5. `rg -n "listFiles|previous_filename|changed_files" .github/workflows/enforce-pr-target.yml`
   — **0건.** 파일 목록을 아예 읽지 않는다는 반증.
6. `bun test tests/ci-workflows.test.ts` 통과.
7. 최종 보고에 "main 승격 전까지 미발효"와 "라벨 생성이 별도 작업"이 명시된다.
