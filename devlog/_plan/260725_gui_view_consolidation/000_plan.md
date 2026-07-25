# 260725 — GUI 뷰 통합: Classic 제거와 단일 Workspace 정착

**Unit:** `devlog/_plan/260725_gui_view_consolidation/`
**Branch:** `dev` 직접 (메인테이너 권한, 별도 PR 없이 push)
**Base:** `origin/dev` @ `3f2098d0` (2026-07-25 16:03 KST, PR #440 머지 시점)
**Work class:** C3 (다중 페이지 UI 표면 + 라우팅/스토리지 계약 제거)
**Mode:** HITL PABCD. 이 문서는 P(계획) 산출물이다.

## Objective

Classic/Workspace 이중 렌더 경로를 없애고 Workspace 단일 경로로 통합한다. 통합
과정에서 Classic이 더 나은 화면(Subagents)은 Classic 쪽 UI를 살려서 그것을 단일
구현으로 삼는다. 함께 사이드바 정보구조를 조정하고 Codex Auth 진입 동선을 줄인다.

## 왜 지금인가

`f541c2d5`(2026-07-22)가 사이드바 전역 Workspace/Classic 토글을 도입한 뒤,
#428·#438·#441이 Dashboard·Models·Subagents Workspace를 차례로 랜딩시켰다. 그
결과 지금 `dev`에는 **같은 화면의 구현이 두 벌씩** 존재한다. 유지비가 페이지마다
두 배로 붙고, `view-mode.ts`는 이미 레거시 키 10개를 마이그레이션하는 부채를
지고 있다.

사용자(메인테이너) 판정: Workspace가 충분히 성숙했으므로 Classic을 제거한다.

## 현재 상태 증거 (live, 2026-07-25 16:0x KST, base `3f2098d0`)

이중 경로를 소비하는 지점:

```text
gui/src/App.tsx:72            useAppRouteState() -> viewMode, toggleGlobalWorkspace
gui/src/App.tsx:236-239       사이드바 하단 Classic/Workspace 토글 버튼
gui/src/App.tsx:277,279,280,282  Dashboard/Providers/Models/Subagents에 viewMode prop 주입
gui/src/view-mode.ts          ViewMode 타입 + 레거시 키 10개 마이그레이션 + providers 해시 변환
gui/src/use-app-route-state.ts
gui/src/app-routing.ts, gui/src/hash-routing.ts
```

Workspace 분기를 가진 페이지 4개:

| 페이지 | Classic | Workspace | 판정 |
| --- | --- | --- | --- |
| Dashboard | `pages/Dashboard.tsx` 내 분기 | `dashboard-workspace-rail` | Workspace 채택 |
| Providers | `pages/Providers.tsx` 내 분기 | `components/provider-workspace/*` (12파일) | Workspace 채택 |
| Models | `pages/Models.tsx` 내 분기 | `styles-models-workspace.css` | Workspace 채택 |
| Subagents | `pages/Subagents.tsx` (181줄) | `components/subagents-workspace/SubagentsWorkspace.tsx` (231줄) | **Classic 채택** |

i18n 키는 6개 로케일(`en/ko/ja/de/ru/zh`)에 각각 존재하며 `pws.classicToggle`,
`pws.workspaceToggle`, `app.viewMode`가 제거 대상이다.

테스트 4종이 이중 경로를 직접 검증한다: `gui/tests/view-mode.test.ts`,
`view-mode-remount.test.tsx`, `providers-hash-history.test.tsx`,
`subagents-workspace.test.ts`.

## 작업 범위

### WP1 — Subagents를 Classic 구현으로 단일화

사용자 판정: Classic 쪽 UI가 더 깔끔하다. 따라서 신설된 Workspace 구현이 아니라
기존 Classic 구현을 남긴다.

- `pages/Subagents.tsx`의 Classic 렌더를 유일 구현으로 승격
- `components/subagents-workspace/SubagentsWorkspace.tsx` 제거
- `styles-subagents-workspace.css` 제거, `styles.css`의 import 정리
- `gui/tests/subagents-workspace.test.ts` 폐기 또는 Classic 계약 테스트로 재작성
- #441이 추가한 i18n 키 중 Workspace 전용 키 회수

> 주의: #441은 06:42 KST에 머지된 신규 작업이다. 되돌리는 것이 아니라 **두 구현
> 중 하나를 고르는** 결정이며, 커밋 메시지에 그 맥락을 남긴다.

### WP2 — 사이드바 정보구조: Codex Auth 승격

현재 `NAV` 순서 (`gui/src/App.tsx:44-55`):

```text
dashboard providers models subagents logs usage storage codex-auth api claude
```

목표: Codex Auth를 Dashboard 다음 두 번째 그룹으로 올린다.

```text
dashboard | codex-auth providers models subagents | logs usage storage | api claude
```

`nav-entry` 마크업은 현재 평면 리스트다. 그룹 구분선을 넣을지, 순서만 바꿀지는
A(감사) 단계에서 확정한다. 순서만 바꾸는 쪽이 CSS 변경 없이 끝난다.

### WP3 — Provider Overview 탭에서 계정 조작 직접 수행

대상은 `pages/CodexAuth.tsx`가 아니라 **Providers workspace의 Overview 탭**이다.

현재 동작 (`ProviderOverview.tsx:85-127`): Overview의 AUTHENTICATION 섹션은
`pws.loggedInAs` 한 줄, 즉 "Logged in as p***1@gmail.com" 텍스트만 보여준다.
조작 버튼은 재인증이 필요할 때(`needsAttention`)만 나타난다. 계정을 바꾸거나
추가하거나 alias를 고치려면 Accounts 탭으로 이동해야 한다.

목표: Overview에서 Accounts 탭과 **동일한 조작**을 할 수 있게 한다. 구체적으로
`ProviderAuthPanel.tsx:140-196`이 제공하는 행위 일체다.

| 조작 | 현재 위치 | 핸들러 |
| --- | --- | --- |
| 계정 전환 | Accounts 탭 행 클릭 | `onSwitchAccount` (`:150`) |
| 재인증 | Accounts 탭 (Overview는 경고 시에만) | `onReauth` (`:169`) |
| alias 편집 | Accounts 탭 | `onEditAlias` (`:174`) |
| 계정 삭제 | Accounts 탭 휴지통 | `onRemoveAccount` (`:180`) |
| 계정 추가 | Accounts 탭 하단 | `onLogin(name, true)` (`:194`) |

구현 방향: `ProviderAuthPanel`의 계정 리스트를 Overview에서 재사용한다.
`ProviderDetails.tsx:247-260`이 Accounts 탭에 넘기는 props와 같은 것을
Overview에도 내려주면 되고, 새 API나 새 상태 소유자는 필요 없다.

A 단계에서 결정할 것:

- 계정 리스트를 통째로 재사용할지, Overview용 컴팩트 변형을 만들지
- 둘 다 렌더되면 Accounts 탭은 남길지 없앨지 (Overview가 완전 대체하면 탭 하나가
  중복이 된다 — `ProviderDetails.tsx:96`의 조건부 탭 정의를 손대게 된다)
- `surface === "codex-accounts"`(OpenAI Codex login)는 `CodexAccountPool`을 통째로
  임베드하는 별도 경로다(`ProviderAuthPanel.tsx:39-47`). Overview에 그대로 넣으면
  세로로 길어지므로 이 표면만 예외로 둘지 판단이 필요하다

### WP4 — Providers 레일 호버 삭제 버튼

사용자가 브라우저에서 직접 지목한 지점: 레일 행(`providers-workspace-rail-row`,
`ProviderRail.tsx:88`) 호버 시 휴지통이 바로 뜨게 한다. 위치는 우측 상태 표시등
(`railStatusCls`, 같은 파일 `rail-trail` 영역) 위에 겹친다.

삭제 핸들러는 이미 있다 — `ProviderDetails.tsx:151-160`의 `onRemoveProvider`가
`IconTrash` 버튼을 그린다. 레일에서 그 콜백을 재사용하면 되고, 새 API는 필요 없다.

> 위험: 레일 행은 `role="option"`인 버튼이다. 그 안에 중첩 `<button>`을 넣으면
> 접근성이 깨진다. 형제 요소로 배치하고 행은 `position: relative`로 잡는다.
> 파괴적 동작이므로 기존 확인 모달(`pws.removeConfirmTitle`)을 반드시 경유한다.

### WP5 — Classic 경로 철거

WP1~WP4가 끝난 뒤 마지막에 수행한다.

- `App.tsx`의 토글 버튼과 `viewMode` prop 주입 제거
- 4개 페이지에서 Classic 분기 삭제
- `view-mode.ts` 제거, `use-app-route-state.ts`/`app-routing.ts`에서 참조 정리
- `providers/workspace` 해시를 `providers`로 정규화하고 구 해시는 한 번 리다이렉트
- 레거시 localStorage 키 10개 정리 경로 결정 (조용히 방치 vs 1회 삭제)
- i18n 6개 로케일에서 토글 키 회수
- `view-mode.test.ts`, `view-mode-remount.test.tsx` 폐기,
  `providers-hash-history.test.tsx`는 단일 해시 계약으로 재작성

## 순서와 근거

```text
WP1 (Subagents 단일화) -> WP2 (NAV 순서) -> WP3 (Codex Auth 진입) -> WP4 (레일 삭제) -> WP5 (Classic 철거)
```

WP5를 마지막에 두는 이유: WP1~WP4를 Classic이 살아있는 상태에서 먼저 끝내면 각
변경을 두 뷰에서 비교 검증할 수 있다. Classic을 먼저 지우면 비교 기준이 사라진다.

## 제약

| 제약 | 출처 | 결과 |
| --- | --- | --- |
| `src/` 프록시 런타임 변경 없음 | 범위 | GUI 전용 유닛, 관리 API 신설 없음 |
| `bun run typecheck` / `test` / `lint:gui` green | `AGENTS.md` | 각 WP 종료 시 게이트 통과 |
| `bun run build:gui` 산출물 갱신 필요 | 로컬 검증 | `gui/dist`는 gitignore 대상, 커밋 아님 |
| 6개 로케일 동기화 | `AGENTS.md` docs sync | 키 제거는 6곳 동시 |
| `dev` 직접 push (메인테이너) | 사용자 지시 | PR 없이 쌓되 커밋 단위는 WP별로 분리 |
| devlog는 gitignore | `.gitignore:6` | 커밋 시 `git add -f` 필요 |

## 완료 기준

1. `rg -n "viewMode|ViewMode|classicToggle" gui/src`가 0건
2. Subagents가 Classic 레이아웃 하나로만 렌더되고 5개 슬롯 저장이 동작
3. 사이드바에서 Codex Auth가 두 번째 그룹에 있고, Provider Overview 탭에서 계정
   전환·추가·삭제·alias 편집·재인증이 모두 가능
4. Providers 레일 행 호버에서 휴지통이 뜨고 확인 모달을 거쳐 삭제됨
5. `typecheck` / `test` / `lint:gui` / `privacy:scan` 전부 green
6. 실제 브라우저에서 4개 화면 스크린샷 확보 (로컬 Vite + 실행 중 프록시)

## 미해결 질문 (A 단계에서 답한다)

- Q1. `providers/workspace` 해시로 들어온 북마크를 리다이렉트할 것인가, 그냥
  `providers`로 처리할 것인가?
- Q2. 레거시 localStorage 키 10개를 1회 삭제할 것인가, 방치할 것인가?
- Q3. NAV 그룹 구분을 시각적 divider로 표현할 것인가, 순서만 바꿀 것인가?
- Q4. Overview가 계정 조작을 전부 흡수하면 Accounts 탭을 없앨 것인가?
- Q5. `codex-accounts` 표면(OpenAI Codex login)은 `CodexAccountPool` 전체를
  임베드하므로 Overview에서 예외 처리할 것인가?
