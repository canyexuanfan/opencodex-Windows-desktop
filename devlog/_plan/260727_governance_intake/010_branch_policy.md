# 010 — dev2-go 기반 PR 허용 + 포팅/리베이스 PR 환영 (diff-level)

WP2 · 근거: `000_survey.md`

## 결정해야 할 것 먼저

조사에서 드러난 함정: `EXPECTED_BASE = "dev"`를 배열
`["dev", "dev2-go"]`로 바꾸면 **아무 PR이나 dev2-go로 보내도 통과**한다.
그러면 Go 포트 브랜치가 일반 기여의 쓰레기통이 된다.

그래서 채택할 모델은 "동등한 두 통합 브랜치"가 아니라
**주 통합선 + 범위가 정해진 병렬 통합선**이다.

- `dev` — 기본값. 별도 이유가 없는 모든 PR.
- `dev2-go` — Go 네이티브 포트 범위 작업. 즉 `go/`, `bin/native-runtime.mjs`,
  `scripts/build-go-release.go`, `scripts/embed-gui.ts`,
  `scripts/prepare-release-assets.ts`, `scripts/reconcile-release-assets.ts`,
  `.github/workflows/go-ci.yml`을 건드리거나, dev2-go에만 있는 코드를
  수정하는 PR.

이 구분이 있어야 워크플로가 "base가 dev2-go인데 go/ 를 전혀 안 건드리는 PR"을
여전히 잡아낼 수 있다.

## 변경 1 — `.github/workflows/enforce-pr-target.yml`

현재 (26행 부근):

    const EXPECTED_BASE = "dev";
    const TITLE_PREFIX = "[WRONG BRANCH] ";

변경 후:

    const DEFAULT_BASE = "dev";
    // Parallel integration lines: base -> the paths that justify targeting it.
    // A PR may target one of these only when it actually touches that line's
    // surface; otherwise it belongs on DEFAULT_BASE. Allowing the base
    // unconditionally would turn a scoped branch into a second inbox.
    const SCOPED_BASES = {
      "dev2-go": [
        /^go\//,
        /^bin\/native-runtime\.mjs$/,
        /^scripts\/build-go-release\.go$/,
        /^scripts\/embed-gui\.ts$/,
        /^scripts\/(prepare|reconcile)-release-assets\.ts$/,
        /^scripts\/ocx-native-launcher\.test\.mjs$/,
        /^scripts\/verify-native-install\.mjs$/,
        /^\.github\/workflows\/go-ci\.yml$/,
      ],
    };
    const TITLE_PREFIX = "[WRONG BRANCH] ";

판정부 (156행 부근):

    const wrongBase = pr.base.ref !== EXPECTED_BASE;

변경 후 — 파일 목록을 읽어 범위를 확인한다:

    async function baseIsJustified() {
      if (pr.base.ref === DEFAULT_BASE) return true;
      const patterns = SCOPED_BASES[pr.base.ref];
      if (!patterns) return false;
      const files = await github.paginate(github.rest.pulls.listFiles, {
        owner, repo, pull_number, per_page: 100,
      });
      // An empty PR cannot justify a scoped base.
      return files.some(f => patterns.some(p => p.test(f.filename)));
    }
    const wrongBase = !(await baseIsJustified());

댓글 문구 (192행 부근)도 두 갈래가 되어야 한다. 현재는 무조건
"pull requests must target `dev`"라고 말하는데, dev2-go를 시도했지만
범위를 못 맞춘 경우와 완전히 엉뚱한 base인 경우는 안내가 달라야 한다.

    // base가 SCOPED_BASES에 있으나 범위 미충족:
    `This pull request targets ${inlineCode(pr.base.ref)}, which is reserved for
     work that touches that line's surface (for \`dev2-go\`: \`go/\`, the native
     runtime entrypoint, and the Go release-asset scripts). This PR does not
     touch any of them, so it belongs on \`dev\`.`

    // 그 외 (main 등):
    (기존 문구 유지)

### 이 변경이 보안 경계인 이유

`.github/workflows/` 수정은 AGENTS.md 리뷰 가이드라인상 **명시적 보안 리뷰
대상**이다. 이 워크플로는 `pull_request_target` 트리거를 쓰므로 더욱 그렇다.
다만 이 변경은 권한을 넓히지 않는다: `permissions: pull-requests: write`는
그대로이고, 새로 필요한 것은 이미 가진 읽기 권한(listFiles)뿐이다.
체크아웃도 없고 PR 코드를 실행하지도 않는다. 이 점을 PR 본문에 명시한다.

## 변경 2 — `.github/workflows/ci.yml` 및 `service-lifecycle.yml`

현재:

    on:
      pull_request:
        branches: [main, dev]

변경 후:

    on:
      pull_request:
        branches: [main, dev, dev2-go]

이유: 지금은 base=dev2-go PR에 크로스플랫폼 CI가 아예 안 돈다.
브랜치를 정식 허용하면서 CI를 안 돌리는 건 허용이 아니라 방치다.

## 변경 3 — `AGENTS.md`

### 3-1. Branch policy (41행 부근)

현재:

    - `dev` — integration branch. All normal pull requests target `dev`.
    - `main` — release branch. ...
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

변경 후 — `dev2-go` 항목을 추가하고 `dev` 문구를 "기본값"으로 완화:

    - `dev` — integration branch and the default target. A pull request goes
      here unless it belongs to a scoped line below.
    - `dev2-go` — parallel integration line for the Go native port: `go/`,
      `bin/native-runtime.mjs`, the Go release-asset scripts, and
      `.github/workflows/go-ci.yml`. Pull requests that change that surface
      target `dev2-go` directly; everything else still targets `dev`.
    - `main` — release branch. ... (기존 유지)
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

그리고 claudedesktop 문단 뒤에 한 문단 추가:

    Porting and rebase pull requests are welcome. Forward-porting a fix from
    one integration line to another, or rebasing a stale branch onto the
    current head, is ordinary maintenance work rather than noise — open it as
    a normal pull request and say in the description which commits it carries
    and where they came from.

### 3-2. Review guidelines / Branch targeting (63행 부근)

현재:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      `dev` (releases and maintainer promotions are the only exceptions).

변경 후:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      an integration branch (releases and maintainer promotions are the only
      exceptions). `dev` is the default; `dev2-go` is correct when the PR
      changes the Go native-port surface. Do not flag a `dev2-go` PR merely for
      not targeting `dev`.

## 변경 4 — `CONTRIBUTING.md`

현재 (13-16행):

    - `dev` — integration target for all normal pull requests.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

변경 후:

    - `dev` — default integration target for pull requests.
    - `dev2-go` — parallel integration line for the Go native port. Target it
      when your change touches `go/`, the native runtime entrypoint, or the Go
      release-asset scripts.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

    Porting and rebase pull requests are welcome: carrying a fix across
    integration lines, or rebasing a stale branch onto the current head, is
    normal contribution. Note the source commits in the description.

## 변경 5 — `MAINTAINERS.md`

현재 (18행):

    - Normal pull requests target `dev`.

변경 후:

    - Pull requests target `dev` by default. `dev2-go` is a parallel
      integration line reserved for Go native-port work; it converges back
      through maintainer-controlled merges, and promotion to `main` still
      happens only from `dev`.

## 범위 밖 (이번 사이클)

- `docs-site/` 5개 로케일 기여 페이지. 이 페이지들에는 branch policy 섹션
  자체가 없어 모순이 생기지 않는다. 공개 문서화는 별도 work-phase.
- `.github/PULL_REQUEST_TEMPLATE.md`에 base 선택 안내 추가.

## 수용 기준

1. `rg -n "dev2-go" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` 가 각 파일에서
   최소 1건씩 매치한다.
2. `rg -n -i "porting|rebase" AGENTS.md CONTRIBUTING.md` 가 환영 문구를 잡는다.
3. `rg -n "dev2-go" .github/workflows/ci.yml .github/workflows/service-lifecycle.yml`
   가 각각 매치한다.
4. `enforce-pr-target.yml`에서 `EXPECTED_BASE` 상수가 사라지고
   `SCOPED_BASES` 범위 판정이 존재한다.
5. `bun test tests/ci-workflows.test.ts` 통과 (워크플로 계약 테스트가 있다).
