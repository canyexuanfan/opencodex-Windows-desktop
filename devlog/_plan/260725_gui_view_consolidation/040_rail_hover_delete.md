# 040 — Providers 레일 행 호버 삭제 (WP4)

> 상위: [`000_plan.md`](./000_plan.md) · 기준 `origin/dev` @ `3f2098d0`
> 사용자가 브라우저에서 직접 지목한 지점: "이런곳 호버했을때 바로 휴지통 버튼
> 뜨도록 (휴지통이 초록불 위에 호버)"

## 목적

Providers workspace 레일에서 프로바이더 행에 마우스를 올리면 우측 상태 표시등
자리에 휴지통이 나타나고, 확인 모달을 거쳐 삭제된다. 지금은 행을 선택해서 상세로
들어간 뒤 헤더의 휴지통을 눌러야 한다.

## 현재 상태

### 삭제 핸들러는 이미 있다

```text
ProviderDetails.tsx:151-160    onRemoveProvider 콜백 + IconTrash 버튼
ProviderDetails.tsx:76         onRemoveProvider?: (name: string) => void
i18n 키 pws.removeConfirmTitle 이미 존재
```

새 API도 새 핸들러도 필요 없다. 레일에서 같은 콜백을 호출하면 된다.

### 행의 DOM 구조가 제약이다

```text
ProviderRail.tsx:86-90    <button role="option" aria-selected className="providers-workspace-rail-row">
ProviderRail.tsx:118-131  마지막 자식이 <span className="providers-workspace-rail-trail">
                          그 안에 pwi-default-star(조건부) + railStatusCls 상태점
ProviderWorkspaceShell.tsx:412-417  items.map(item => <RailRow .../>) — 행 래퍼가 없다
```

CSS도 제약을 건다:

```text
provider-workspace-shell.css:209-227
  .providers-workspace-rail-row {
    display: grid;
    grid-template-columns: var(--icon-lg) minmax(0,1fr) max-content;
    overflow: hidden;        <- 넘치는 자식이 잘린다
  }
  (position 속성 없음)
```

### 000_plan.md의 초기 서술은 틀렸다

계획서 WP4는 "형제 요소로 배치하고 행은 `position: relative`로 잡는다"고 적었는데,
**형제는 형제를 기준으로 절대 배치되지 않는다.** 게다가 행을 감싸는 래퍼가 아예
없어서 형제를 만들 자리 자체가 없다. 이 문서가 그 서술을 대체한다.

### 행 안에 버튼을 넣으면 깨지는 것들

| 문제 | 근거 |
| --- | --- |
| `<button>` 안의 `<button>`은 유효하지 않은 HTML | `ProviderRail.tsx:86` |
| `role="option"` 안의 인터랙티브 자손은 접근성 위반 | 같은 곳 |
| 클릭 버블링으로 삭제와 선택이 동시에 일어남 | `onClick={onClick}` (`:88`) |
| 키보드 탐색이 어긋남 — `el.contains(active)`가 삭제 버튼 포커스를 행 포커스로 취급 | `ProviderWorkspaceShell.tsx:392` |
| 호버 전용 노출은 키보드/터치 사용자에게 보이지 않음 | 설계 문제 |

## 변경 계획

### 1. 행 래퍼 도입 (`ProviderWorkspaceShell.tsx`)

`items.map`이 `RailRow`를 직접 뱉는 대신 래퍼로 감싼다.

```text
before:  {items.map(item => <RailRow key={item.name} item={item} ... />)}

after:   {items.map(item => (
           <div key={item.name} className="pws-rail-row-wrap">
             <RailRow item={item} ... />
             {onRemoveProvider && (
               <button
                 type="button"
                 className="pws-rail-row-remove"
                 tabIndex={-1}
                 aria-hidden="true"
                 onClick={e => { e.stopPropagation(); onRemoveProvider(item.name); }}
                 title={t("pws.removeConfirmTitle")}
               >
                 <IconTrash />
               </button>
             )}
           </div>
         ))}
```

**`tabIndex={-1}` + `aria-hidden`인 이유:** 이 버튼은 마우스 사용자를 위한
가속 경로일 뿐이고, 키보드/스크린리더 사용자에게는 이미
`ProviderDetails.tsx:151-160`의 접근 가능한 삭제 버튼이 있다. 레일 버튼을 탭 순서에
넣으면 `listbox` 옵션 탐색이 흐트러진다(`ProviderWorkspaceShell.tsx:389-392`).
접근 경로를 새로 만드는 게 아니라 기존 경로의 단축키를 더하는 것이므로, 보조기술에
중복 노출하지 않는 편이 낫다.

> 대안으로 `tabIndex={0}`을 주고 `listbox` 키보드 핸들러에서 제외하는 방법도
> 있지만, `options.findIndex(el => el === active || el.contains(active))`가
> 래퍼 기준으로 다시 계산돼야 해서 회귀 위험이 크다. B단계에서 첫 번째 안으로
> 구현하고, 실제 스크린리더 확인 후 필요하면 승격한다.

### 2. 래퍼 CSS (`provider-workspace-shell.css`)

```css
.pws-rail-row-wrap { position: relative; }

.pws-rail-row-remove {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast);
  /* 나머지는 btn-ghost btn-icon-only 규약 재사용 */
}

.pws-rail-row-wrap:hover .pws-rail-row-remove,
.pws-rail-row-wrap:focus-within .pws-rail-row-remove {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  /* 터치 기기에서는 호버가 없다 — 노출하지 않고 상세 화면 경로를 쓴다 */
  .pws-rail-row-remove { display: none; }
}
```

행의 `overflow: hidden`(`:225`)은 그대로 둔다. 휴지통이 래퍼 기준 절대배치라
행 내부 클리핑 대상이 아니다.

### 3. 상태점과의 겹침

사용자 요구는 "휴지통이 초록불 위에 호버"다. 상태점은
`providers-workspace-rail-trail` 안에 있고(`ProviderRail.tsx:118-131`), 래퍼 절대배치
휴지통이 그 위를 덮는다. 별도 처리 없이 z축으로 겹친다 — 다만 상태점이 비쳐
보이지 않도록 휴지통 버튼에 배경(`background: var(--surface)`)을 준다.

### 4. 확인 모달 경유

파괴적 동작이므로 기존 확인 경로를 반드시 탄다. `onRemoveProvider`가 이미
`ProviderDialogs.tsx` 확인 모달을 띄우는지 B단계 착수 시 확인하고, 아니라면
`ProviderDetails.tsx:151-160`과 동일한 경로를 태운다.

## 검증

```bash
bun run typecheck
bun run lint:gui
bun run test
bun run build:gui
```

브라우저(로컬 Vite 5199):

1. `#providers/workspace`에서 레일 행에 마우스 올리기 → 휴지통 노출 스크린샷
2. 휴지통 클릭 → 확인 모달 스크린샷
3. 모달 취소 → 프로바이더가 남아있는지 확인
4. 레일에 포커스 두고 ArrowDown/ArrowUp/Home/End → 행 사이 이동이 정상인지 확인
   (회귀 확인 — `ProviderWorkspaceShell.tsx:389-401`)

## 위험

- **키보드 탐색 회귀.** 래퍼 도입으로 `options` 쿼리 결과가 바뀌지 않아야 한다.
  `querySelectorAll('[role="option"]')`는 여전히 `RailRow`만 잡으므로 이론상 안전하지만
  실제 확인이 필요하다.
- **실수 삭제.** 호버만으로 파괴 버튼이 나타나므로 확인 모달이 유일한 방어선이다.
  모달 없이 즉시 삭제되면 안 된다.
- **선택 상태와의 상호작용.** 선택된 행은 배경이 다르다(`:230-234`). 휴지통 배경이
  그 위에서도 읽히는지 확인한다.
