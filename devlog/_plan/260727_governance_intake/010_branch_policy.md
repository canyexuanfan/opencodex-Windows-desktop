# 010 — dev2-go 기반 PR 허용 + 포팅/리베이스 PR 환영 (diff-level, rev2)

WP2 · 근거: `000_survey.md` · 1차 감사 FAIL 반영: `011_audit_round1.md`

## 먼저: 이 변경이 언제 발효되는가

**중요한 제약이다.** `enforce-pr-target.yml`은 `pull_request_target`
트리거를 쓰고, GitHub은 이 트리거에 대해 **기본 브랜치(main)의 워크플로**를
실행한다. 저장소 기본 브랜치는 `main`이다.

    gh repo view lidge-jun/opencodex --json defaultBranchRef   # main

즉 `dev`에 워크플로를 고쳐 커밋해도 **PR 판정 동작은 그대로다.**
dev2-go PR은 main 승격 전까지 계속 `[WRONG BRANCH]` 접두사와 강제 draft를
받는다.

따라서 이 work-phase의 산출물은:

1. **dev에 커밋 (지금)** — 문서 3개 + `dev`의 워크플로 변경.
2. **main 승격 (사용자 승인 필요, 범위 밖)** — 실제 발효 시점.
3. **dev2-go 브랜치 작업 (별도)** — 그쪽 CI 트리거 (아래 "변경 2" 참조).

이 한계를 보고에 반드시 포함한다. 문서만 고치고 "허용했다"고 말하는 것은
사실과 다르다.

## 채택 모델

"동등한 두 통합 브랜치"가 아니라 **주 통합선 + 범위가 정해진 병렬 통합선**.

- `dev` — 기본값. 별도 이유가 없는 모든 PR.
- `dev2-go` — Go 네이티브 포트 범위 작업 전용.

## 변경 1 — `.github/workflows/enforce-pr-target.yml`

### 1-1. 트리거에 `synchronize` 추가

현재:

    on:
      pull_request_target:
        types: [opened, reopened, edited, ready_for_review]

변경 후:

    on:
      pull_request_target:
        types: [opened, reopened, edited, ready_for_review, synchronize]

이유: 범위 판정이 파일 목록에 의존하게 되므로, 최초 통과 후 push로
비범위 파일을 추가하면 재판정되어야 한다. `synchronize`가 없으면
정책이 한 번만 강제되고 그 뒤로는 무방비다.

### 1-2. 허용 집합 정의

현재 (26행):

    const EXPECTED_BASE = "dev";
    const TITLE_PREFIX = "[WRONG BRANCH] ";

변경 후:

    const DEFAULT_BASE = "dev";

    // Files that justify targeting a scoped integration line. Verified against
    //   git diff --diff-filter=A --name-only origin/dev...origin/dev2-go
    // on 2026-07-27 — every dev2-go-only source path is covered here.
    const SCOPED_BASES = {
      "dev2-go": [
        /^go\//,
        /^bin\/native-runtime\.mjs$/,
        /^src\/lib\/runtime-entry\.ts$/,
        /^scripts\/build-go-release\.go$/,
        /^scripts\/embed-gui\.ts$/,
        /^scripts\/(prepare|reconcile)-release-assets\.ts$/,
        /^scripts\/ocx-native-launcher\.test\.mjs$/,
        /^scripts\/verify-native-install\.mjs$/,
        /^tests\/prebridge-runtime-rebake\.test\.ts$/,
        /^tests\/(prepare|reconcile)-release-assets\.test\.ts$/,
        /^\.github\/workflows\/go-ci\.yml$/,
      ],
    };

    // Paths that carry no line-specific meaning, so they may ride along with a
    // scoped PR without turning it into a general-purpose change.
    const SHARED_PATHS = [
      /^devlog\//,
      /^structure\//,
      /^docs\//,
      /^\.gitignore$/,
    ];

    const TITLE_PREFIX = "[WRONG BRANCH] ";

### 1-3. 판정: 일부가 아니라 전량 검사

현재 (156행):

    const wrongBase = pr.base.ref !== EXPECTED_BASE;

변경 후:

    async function baseIsJustified() {
      if (pr.base.ref === DEFAULT_BASE) return true;
      const scoped = SCOPED_BASES[pr.base.ref];
      if (!scoped) return false;

      const files = await github.paginate(github.rest.pulls.listFiles, {
        owner, repo, pull_number, per_page: 100,
      });
      // An empty PR cannot justify a scoped base.
      if (files.length === 0) return false;

      // EVERY file must belong to the line's surface (or be line-neutral), and
      // at least one must be line-specific. Checking "some file matches" would
      // let one go/ file smuggle an arbitrary src/ or credential change onto a
      // branch that exists for a narrow purpose.
      let sawScoped = false;
      for (const file of files) {
        const name = file.filename;
        if (scoped.some(p => p.test(name))) { sawScoped = true; continue; }
        if (SHARED_PATHS.some(p => p.test(name))) continue;
        return false;
      }
      return sawScoped;
    }
    const wrongBase = !(await baseIsJustified());

`permissions: pull-requests: write`는 `listFiles`에 필요한 읽기 권한을
포함하므로 권한 확대가 없다. 이 워크플로는 PR 코드를 체크아웃하지도
실행하지도 않는다 — `pull_request_target`에서 위험한 것은 그 두 가지인데,
둘 다 하지 않는다.

### 1-4. 안내 문구 분기

현재는 무조건 "must target `dev`"라고 말한다. 세 경우가 구분되어야 한다:

    // (a) scoped base인데 범위 미충족
    `This pull request targets ${inlineCode(pr.base.ref)}, which is reserved for
     work on that line's surface (for \`dev2-go\`: \`go/\`, the native runtime
     entrypoint, and the Go release-asset scripts). This PR changes files
     outside that surface, so it belongs on \`dev\`.`

    // (b) scoped base인데 변경 파일이 없음
    `This pull request targets ${inlineCode(pr.base.ref)} but changes no files
     on that line's surface.`

    // (c) 그 외 (main 등) — 기존 문구 유지

## 변경 2 — CI 커버리지 (dev2-go 브랜치 작업, 별도 PR)

`pull_request` 트리거의 워크플로는 **PR의 base 브랜치 버전**이 실행된다.
따라서 `dev`의 `ci.yml`을 고쳐도 base=dev2-go PR에는 적용되지 않는다.

    git show origin/dev2-go:.github/workflows/ci.yml | sed -n 3,5p
    #   pull_request:
    #     branches: [main, dev]

필요한 변경은 **dev2-go 브랜치에서** 이뤄져야 한다:

- `dev2-go`의 `.github/workflows/ci.yml` → `branches: [main, dev, dev2-go]`
- `dev2-go`의 `.github/workflows/service-lifecycle.yml` → 동일
- `dev2-go`의 `.github/workflows/go-ci.yml` → `pull_request` 트리거 추가
  (현재 `push`와 `workflow_dispatch`만 있음)

이건 dev 작업이 아니므로 **이번 work-phase 범위 밖**으로 분리하고,
후속 work-phase 또는 dev2-go 대상 PR로 처리한다. 문서에는 "CI 커버리지는
dev2-go 쪽 후속 작업"이라고 명시한다.

일관성을 위해 `dev`의 `ci.yml`/`service-lifecycle.yml`에도 `dev2-go`를
추가한다 — main 승격 시 두 브랜치가 같은 정책을 갖게 된다.

## 변경 3 — `AGENTS.md`

### 3-1. Branch policy (41행 부근)

    - `dev` — integration branch and the default target. A pull request goes
      here unless it belongs to a scoped line below.
    - `dev2-go` — parallel integration line for the Go native port: `go/`,
      `bin/native-runtime.mjs`, `src/lib/runtime-entry.ts`, the Go
      release-asset scripts, and `.github/workflows/go-ci.yml`. Target it
      directly when your change is confined to that surface; anything wider
      still goes to `dev`.
    - `main` — release branch. (기존 유지)
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

claudedesktop 문단 뒤에 추가:

    Porting and rebase pull requests are welcome. Forward-porting a fix from
    one integration line to another, or rebasing a stale branch onto the
    current head, is ordinary maintenance rather than noise — open it as a
    normal pull request and name the source commits in the description.

### 3-2. Review guidelines / Branch targeting (63행 부근)

    - **Branch targeting:** flag any pull request that targets `main` instead of
      an integration branch (releases and maintainer promotions are the only
      exceptions). `dev` is the default; `dev2-go` is correct when the change is
      confined to the Go native-port surface. Do not flag a `dev2-go` PR merely
      for not targeting `dev`.

## 변경 4 — `CONTRIBUTING.md` (13-16행)

    - `dev` — default integration target for pull requests.
    - `dev2-go` — parallel integration line for the Go native port. Target it
      when your change is confined to `go/`, the native runtime entrypoint, or
      the Go release-asset scripts.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

    Porting and rebase pull requests are welcome: carrying a fix across
    integration lines, or rebasing a stale branch onto the current head, is
    normal contribution. Note the source commits in the description.

## 변경 5 — `MAINTAINERS.md` (18행)

    - Pull requests target `dev` by default. `dev2-go` is a parallel
      integration line reserved for Go native-port work; it converges back
      through maintainer-controlled merges, and promotion to `main` still
      happens only from `dev`.

## 범위 밖

- **main 승격** — 워크플로 발효에 필요하지만 사용자 승인 사항.
- **dev2-go 브랜치의 CI 트리거** — 별도 작업(위 변경 2).
- `docs-site/` 5개 로케일 기여 페이지 — branch policy 섹션 자체가 없어
  모순이 생기지 않는다.
- `.github/PULL_REQUEST_TEMPLATE.md` base 선택 안내.

## 수용 기준

1. `rg -n "dev2-go" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 각 파일 1건 이상.
2. `rg -n -i "porting|rebase" AGENTS.md CONTRIBUTING.md` — 환영 문구 매치.
3. `rg -n "dev2-go" .github/workflows/ci.yml .github/workflows/service-lifecycle.yml`
   — 각 1건.
4. `enforce-pr-target.yml`에 `EXPECTED_BASE` 상수가 없고, `SCOPED_BASES`,
   `SHARED_PATHS`, `synchronize`가 전부 존재.
5. `rg -n "some\(f => patterns" .github/workflows/enforce-pr-target.yml` — 0건
   (전량 검사로 바뀌었다는 반증).
6. `bun test tests/ci-workflows.test.ts` 통과.
7. **보고서에 "main 승격 전까지 미발효"가 명시된다.**
