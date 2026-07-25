# WP7 — local dev 통합과 이슈/PR 종료

## 루프 계약

- **Archetype:** repair/integration
- **Trigger:** 사용자가 최신 local `dev` 위로 버그 스윕을 재배치하고 `dev`에 직접 반영한 뒤,
  이번 수정으로 해결되는 이슈와 대체되는 PR을 코멘트와 함께 닫으라고 승인했다.
- **Goal:** `codex/260725-bug-sweep`의 다섯 버그 수정만 최신 local `dev` 위에 보존하고,
  검증된 결과를 `origin/dev`에 게시한 뒤 GitHub 상태를 실제 결과와 맞춘다.
- **Non-goals:** #418, #417, #241, #420/#430, #435/#436, GUI enhancement, 릴리스와 `main`
  승격은 건드리지 않는다. #433의 CLI escape hatch와 GUI 가시화도 이번 종료 근거에 포함하지
  않는다.
- **Verifier:** `git merge-tree --write-tree`, rebase 뒤 focused tests, `bun run typecheck`,
  `bun run test`, `bun run privacy:scan`, 원격 `dev` SHA 대조, GitHub issue/PR 상태 재조회.
- **Stop condition:** local `dev`와 `origin/dev`가 같은 통합 SHA를 가리키고, #433/#432/#422/
  #373/#404가 근거 코멘트와 함께 closed이며, 대체되는 열린 PR만 닫혀 있다.
- **Memory artifact:** 이 문서 하단의 실행 영수증과 WP6 검증 기록.
- **Terminal outcomes:** DONE, BLOCKED(충돌·신규 회귀·원격 거부), UNSAFE(관련 없는 local `dev`
  변경을 덮어써야 하는 경우), NEEDS_HUMAN(해결 여부가 구현 근거만으로 확정되지 않는 경우).
- **Escalation:** 통합 충돌이나 테스트 회귀는 main session이 회수한다. 이슈/PR 종료 판단은
  독립 감사에서 blocker가 두 번 남으면 자동 종료하지 않고 사용자에게 되돌린다.

## 착수 시점 사실

- 작업 워크트리: `/Users/jun/.codex/worktrees/404d/opencodex`
- 버그 스윕 tip: `f76d79ef907185644997010d0091fc64e3b7d5c8`
- local `dev` tip: `f0db9188d11b87f45f5cca0f52d6e447b6b51428`
- fetch 뒤 `origin/dev`: `9b37ef5a926388e7570bd819512ac3dbc8ae18e5`
- local `dev`는 `origin/dev`보다 1커밋 앞서며, `dev` 워크트리에는 사용자 소유
  `devlog/_plan/.DS_Store` 수정이 있다. 이 파일은 stage, restore, commit하지 않는다.
- merge-base 이후 local `dev`의 41개 커밋과 스윕의 14개 커밋은 변경 파일 교집합이 없고,
  `git merge-tree --write-tree dev codex/260725-bug-sweep`가 tree
  `964c0433f05fee1325cf284639eb9d0547eb0277`를 생성했다.

## 변경 계약

### 1. 스윕 브랜치 재배치

```diff
- codex/260725-bug-sweep: <옛 merge-base> + 14 commits
+ codex/260725-bug-sweep: local dev@f0db9188 + 같은 14개 논리 커밋
```

- 현재 clean 워크트리에서 `git rebase dev`를 실행한다.
- 충돌이 생기면 자동 해석하지 않고 파일별로 local `dev`와 스윕 의도를 대조한다.
- 재배치 뒤 `dev..codex/260725-bug-sweep`가 정확히 스윕 커밋 14개인지 확인한다.

### 2. 검증

focused activation tests:

```bash
bun test tests/codex-routing.test.ts tests/service.test.ts \
  tests/responses-compaction-routing.test.ts tests/cursor-blob.test.ts \
  tests/cursor-live-transport.test.ts tests/cursor-protobuf-events.test.ts \
  tests/adapter-resolve.test.ts tests/config.test.ts \
  tests/management-provider-validation.test.ts
```

full gates:

```bash
bun run typecheck
bun run test
bun run privacy:scan
```

- full suite의 기존 GUI dependency 실패는 WP6 기준선과 동일한지 다시 확인한다.
- 신규 실패가 있으면 push와 GitHub 종료를 중단한다.

### 3. local dev fast-forward와 push

```diff
- dev: f0db9188
+ dev: <rebased sweep tip>
```

- `/Users/jun/Developer/new/700_projects/opencodex`에서 `git merge --ff-only
  codex/260725-bug-sweep`를 실행한다.
- `.DS_Store` 수정이 그대로 남았는지 확인한다.
- 원격 선행 변경이 없는지 한 번 더 fetch하고 `origin/dev`가 현재 local `dev`의 ancestor인지
  확인한 뒤 `git push origin dev`한다. force push는 사용하지 않는다.
- push 뒤 `git ls-remote origin refs/heads/dev`와 local SHA가 같아야 한다.

### 4. GitHub 종료 범위

dev push가 확인된 뒤 다음 순서로 처리한다.

| 항목 | 조치 | 근거 |
|---|---|---|
| issue #433 | 구현 범위와 남은 CLI/GUI 후속을 구분해 코멘트 후 close | probe lease와 reset-derived 15분 상한이 핵심 stale cooldown을 해소 |
| issue #432 | 코멘트 후 close | 생략된 Task Scheduler 기본값과 explicit unsafe 값 회귀 테스트 |
| issue #422 | 코멘트 후 close | canonical forward capability gate와 synthetic path 회귀 테스트 |
| issue #373 | 코멘트 후 close | 실제 전송 payload 기반 request-local estimate와 restart/checkpoint-less 회귀 테스트 |
| PR #376 | 먼저 기여에 감사를 표하고 통합 구현이 dev에 들어갔음을 설명한 뒤 close | 같은 #373을 다루며 현재 reviewDecision은 CHANGES_REQUESTED |
| issue #404 | 코멘트 후 close | `modelAdapters` per-model override와 validator/resolver 회귀 테스트 |

- PR #376 외 다른 열린 PR은 이번 다섯 이슈를 직접 대체하지 않는다.
- #430/#436은 별도 버그를 해결하므로 유지한다. #408은 Windows elevation 문제라 #432와
  겹치지 않으므로 유지한다.
- 코멘트에는 최종 `dev` SHA와 해당 구현 커밋 SHA, 검증 결과를 넣는다. issue를 먼저 닫아
  PR 자동 문구가 문맥을 흐리지 않도록 PR #376은 별도 설명과 함께 닫는다.

## 수용 기준

- rebase와 fast-forward가 비강제 방식으로 끝난다.
- 사용자 소유 `.DS_Store` 수정이 보존된다.
- focused tests, typecheck, privacy scan이 0으로 끝나고 full suite가 기준선보다 악화되지 않는다.
- `origin/dev`가 최종 local `dev` SHA와 일치한다.
- #433/#432/#422/#373/#404와 PR #376의 최종 상태·코멘트 URL을 이 문서에 기록한다.

## 실행 영수증

_(C/D 단계에서 작성)_
