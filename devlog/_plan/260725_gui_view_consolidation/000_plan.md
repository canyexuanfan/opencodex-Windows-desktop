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

### WP2 — 사이드바 정보구조 + Dashboard 상단 탭 (D4)

#### WP2a — Codex Auth 승격

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

#### WP2b — Dashboard 좌측 레일 → 상단 탭

현재 Dashboard workspace는 좌측 세로 레일이다(`Dashboard.tsx:1394-1404`,
`dashboard-workspace-rail`). 이를 Logs & Debug와 같은 상단 탭으로 바꾼다.

재사용 대상은 이미 존재한다:

```text
gui/src/pages/Logs.tsx:334   <div className="page-tabs" role="tablist">
gui/src/styles.css:370       .page-tabs { display:flex; gap:2px; border-bottom:1px solid var(--border); }
```

`.page-tabs`는 현재 Logs 한 곳에서만 쓰인다. Dashboard가 두 번째 소비자가 되므로
공용 규약으로 승격된다.

**탭 상태는 해시에 남긴다(D4 확정).** Logs는 `#logs/debug`를 라우터가 인식하도록
등록해 두었다(`app-routing.ts:49,80-83`). Dashboard도 같은 방식이 필요하다 —
현재는 `#dashboard/...` 접미사가 무효로 취급되어 `#dashboard`로 되돌려진다
(`app-routing.ts:35-49`, `use-app-route-state.ts:73-100`). 따라서 라우터에 Dashboard
하위 해시를 등록하는 작업이 포함된다.

A 단계에서 결정할 것: 세 섹션의 해시 이름(`#dashboard/providers` 형태), 그리고
좁은 폭에서 탭 3개가 넘칠 때의 동작(줄바꿈 vs 가로 스크롤).

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

#### 인터뷰 확정 결정 (2026-07-25, I-phase 라운드 1~2)

- **D1 껍데기 통일.** 모든 프로바이더가 같은 계정 행 레이아웃과 같은 버튼 위치를
  쓴다. 의미가 다른 지점은 문구/배지로 드러낸다.
- **D2 Accounts 탭 유지.** Overview는 요약 + 조작, Accounts는 전체 목록 + 고급
  설정. 중복은 의도된 것이다 — Overview가 메인 표면이기 때문이다.
- **D3 범위 확대.** docs-site 갱신을 WP6으로 추가하고, WP3에 보안 자기검토
  게이트를 명시한다.
- **D4 Dashboard 상단 탭.** 좌측 섹션 레일(`Dashboard.tsx:1394`)을 Logs & Debug와
  같은 상단 탭(`Logs.tsx:334` `.page-tabs`)으로 교체하고, 탭 상태를 해시에 남긴다.
- **D5 상태 공유(공유 소스 통합).** Overview와 Accounts가 각자 상태를 갖지 않는다.
  필요하면 API와 상태 소유자를 바꿔서 **하나의 공유 상태**를 두 표면이 함께
  쓰도록 리프팅한다. 아래 WP3a가 이 작업이다.

### WP3a — 계정 상태 소유자 리프팅 (D5)

D5는 이 유닛에서 유일하게 `src/`를 건드릴 수 있는 항목이다. 나머지 WP는 GUI 전용.

현재 두 계정 체계는 **상태 소유자가 다르다**:

| | OAuth/API-key | Codex |
| --- | --- | --- |
| 소유자 | `useProviderAccountPools` (부모 `Providers.tsx`가 보유) | `CodexAccountPool` 내부 `useState` 14개 |
| 목록 | `accountSets` | 컴포넌트 로컬 `accounts` |
| 전환 중 | `switchingAccount` | 로컬 `switchingId` |
| 토스트 | 부모 `notify` | 로컬 `toast`/`toastError` |

`CodexAccountPool.tsx:39-53`이 로컬 상태를 전부 소유하므로, 같은 컴포넌트를 두
표면에 각각 마운트하면 상태가 갈라진다. 따라서 **훅으로 추출**한다:
`useCodexAccountPool(apiBase)`를 만들어 `Providers.tsx`가 소유하고, Overview와
Accounts 양쪽에 같은 인스턴스를 내려준다. `CodexAccountPool`은 표시 전용이 된다.

API 측은 이미 대칭이다 — 통합을 막는 백엔드 제약은 없다:

```text
PUT /api/oauth/accounts/active   {provider, accountId}  (oauth-account-routes.ts:162)
PUT /api/codex-auth/active       {accountId}            (codex/auth-api.ts:504)
PUT /api/oauth/accounts/alias    (:173)  <-> /api/codex-auth/accounts/alias
DELETE /api/oauth/accounts       (:187)  <-> DELETE /api/codex-auth/accounts
```

> **다만 "즉시 전환 vs 다음 세션"은 UI 문제가 아니다.** 두 엔드포인트 모두 즉시
> 상태를 쓴다(`auth-api.ts:512-514`). 차이는 **소비 측**에 있다:
> `src/codex/routing.ts:404-419`의 `threadAccountMap` 스레드 어피니티가 이미
> 진행 중인 스레드를 기존 계정에 고정하므로, 활성 계정을 바꿔도 **진행 중인
> 스레드는 안 바뀐다**. 그래서 "다음 세션부터"라는 문구가 붙은 것이다. OAuth에는
> 이 어피니티 계층이 없어서 즉시 반영된다.
>
> 결론: D1의 "껍데기 통일 + 문구로 차이 표시"는 이 구조와 정확히 맞다. 이 의미
> 차이를 없애려면 스레드 어피니티를 손대야 하는데, 그것은 라우팅 런타임 변경이며
> 이 유닛의 범위 밖이다. **범위 밖임을 명시적으로 기록한다.**

A 단계에서 결정할 것:

- `useCodexAccountPool` 추출 범위 — 14개 상태 전부인지, 목록/활성/전환만인지
  (모달·토스트는 표시 계층에 남길 수 있다)
- Codex main 계정은 remove/alias가 없다(`CodexAccountPool.tsx:304-327`). 공유 행
  레이아웃에서 그 자리를 빈 슬롯으로 둘지, 비활성 버튼으로 둘지
- Overview 2단 그리드에서 계정 행이 들어갈 물리적 위치
  (`provider-workspace-shell.css:526-551`, 사이드바 280px 고정)

### WP6 — docs-site 동기화 (D3)

`docs-site/src/content/docs/guides/web-dashboard.md`와 4개 번역(ko/ja/ru/zh-cn)이
Classic/Workspace 토글과 `#providers/workspace`를 명시적으로 안내한다(각 44행
부근). WP5가 이 둘을 없애므로 5개 파일을 함께 고친다. D4의 Dashboard 탭 변경도
같은 문서에 반영한다.

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
WP1 (Subagents 단일화)
  -> WP2a (NAV 순서) -> WP2b (Dashboard 상단 탭 + 해시 등록)
  -> WP3a (계정 상태 리프팅) -> WP3 (Overview 계정 조작)
  -> WP4 (레일 호버 삭제)
  -> WP5 (Classic 철거)
  -> WP6 (docs-site 5개 파일)
```

WP3a가 WP3보다 먼저인 이유: 상태 소유자를 먼저 하나로 만들지 않으면 Overview와
Accounts가 각자 상태를 갖게 되어 D2(중복 허용)가 곧바로 동기화 버그가 된다.

WP6이 마지막인 이유: 문서는 최종 동작을 기술해야 하므로 WP5까지 끝난 뒤 한 번에
고친다.

WP5를 마지막에 두는 이유: WP1~WP4를 Classic이 살아있는 상태에서 먼저 끝내면 각
변경을 두 뷰에서 비교 검증할 수 있다. Classic을 먼저 지우면 비교 기준이 사라진다.

## 제약

| 제약 | 출처 | 결과 |
| --- | --- | --- |
| `src/` 변경은 WP3a 상태 리프팅에 한정 | D5 + 범위 | 라우팅/어피니티 런타임은 건드리지 않는다 |
| 스레드 어피니티(`routing.ts:404-419`) 변경 금지 | 범위 밖 | "다음 세션" 의미는 문구로만 표현한다 |
| 인증/자격증명 표면 변경은 보안 검토 대상 | `AGENTS.md:65`, `MAINTAINERS.md:22` | WP3/WP3a는 자기검토 게이트를 거친다 (D3) |
| `bun run typecheck` / `test` / `lint:gui` green | `AGENTS.md` | 각 WP 종료 시 게이트 통과 |
| `bun run build:gui` 산출물 갱신 필요 | 로컬 검증 | `gui/dist`는 gitignore 대상, 커밋 아님 |
| 6개 로케일 동기화 | `AGENTS.md` docs sync | 키 제거는 6곳 동시 |
| `dev` 직접 push (메인테이너) | 사용자 지시 | PR 없이 쌓되 커밋 단위는 WP별로 분리 |
| devlog는 gitignore | `.gitignore:6` | 커밋 시 `git add -f` 필요 |

## 완료 기준

1. `rg -n "viewMode|ViewMode|classicToggle" gui/src`가 0건
2. Subagents가 Classic 레이아웃 하나로만 렌더되고 5개 슬롯 저장이 동작
3. 사이드바에서 Codex Auth가 두 번째 그룹에 있음
4. Dashboard가 상단 탭으로 전환되고, 탭이 해시에 반영되어 새로고침·뒤로가기가
   탭을 기억함
5. Provider Overview에서 계정 전환·추가·삭제·alias 편집·재인증이 모두 가능하고,
   **Overview에서 조작한 결과가 Accounts 탭에 즉시 반영됨** (공유 상태 증명)
6. Codex 행에 "다음 세션" 배지가 있고 다른 프로바이더 행과 버튼 위치가 동일함
7. Providers 레일 행 호버에서 휴지통이 뜨고 확인 모달을 거쳐 삭제됨
8. `typecheck` / `test` / `lint:gui` / `privacy:scan` 전부 green
9. docs-site 5개 파일에 Classic/Workspace 및 `#providers/workspace` 언급이 남아
   있지 않음
10. 실제 브라우저 스크린샷: Dashboard 탭, Subagents, Provider Overview 계정 조작,
    레일 호버 삭제
11. WP3/WP3a 보안 자기검토 기록 (자격증명 로깅 없음, 권한 확대 없음)

## 미해결 질문 (A 단계에서 답한다)

- Q1. `providers/workspace` 해시로 들어온 북마크를 리다이렉트할 것인가, 그냥
  `providers`로 처리할 것인가?
- Q2. 레거시 localStorage 키 10개를 1회 삭제할 것인가, 방치할 것인가?
- Q3. NAV 그룹 구분을 시각적 divider로 표현할 것인가, 순서만 바꿀 것인가?
- Q6. `useCodexAccountPool` 추출 범위 (14개 상태 전부 vs 목록/활성/전환만)
- Q7. Dashboard 탭 해시 이름과 좁은 폭 넘침 처리
- Q8. Overview 2단 그리드에서 계정 행의 물리적 배치

> Q4/Q5는 D2/D1/D5로 해소되었다. Accounts 탭은 유지하고, Codex도 예외 없이 같은
> 껍데기를 쓰되 상태를 공유한다.

## OPEN ASSUMPTIONS

- OA1 (medium). Overview 2단 그리드 우측 사이드바가 280px 고정이라 계정 행이
  좁아질 수 있다. 실제 렌더 확인 전까지 "행이 들어간다"는 가정이다.
  근거: `provider-workspace-shell.css:526-551`.
- OA2 (medium). `.page-tabs`는 현재 Logs 전용이라 3개 탭·좁은 폭 검증이 없다.
- OA3 (low). i18n 제거 규모는 로케일당 13키(총 78)로 추정한다. `sub.workspace.*`
  10키 + 토글 3키. `pws.accountsLoading`/`retryAccounts`는 공유 키이므로 제거 대상이
  아니다.
- OA4 (low). WP1이 되돌리는 #441은 오늘 아침 머지된 신규 작업이다. 기여자 관점의
  후속 설명이 필요할 수 있다.
