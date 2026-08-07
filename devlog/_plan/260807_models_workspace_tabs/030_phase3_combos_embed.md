# Phase 3 — Combos as a panel

The hard phase. Combos is the only surface in the GUI that opts out of the normal
980px scrolling column: it is a full-bleed `100dvh` workspace whose rail and detail
pane scroll independently. Making it a tab means reconciling that with a page header
and a tab strip that must stay visible above it.

## The selector that actually breaks

```css
.main-inner.main-inner--combos > .combos-workspace-shell { flex: 1 1 auto; min-height: 0; height: 100%; ... }
```

`gui/src/styles.css:399`. It is a **direct-child** selector. Today `Combos` returns
`.combos-workspace-shell` as `.main-inner`'s immediate child, so it matches.

As a tab, the shell sits inside a panel wrapper:

```
.main-inner--combos
├─ .page-head          (header, stays visible)
├─ .page-tabs          (strip, stays visible)
└─ #models-panel-combos   ← new wrapper
   └─ .combos-workspace-shell   ← no longer a direct child
```

The rule stops matching, the shell loses `flex: 1 1 auto` and `min-height: 0`, and the
workspace collapses to content height inside a clipped `100dvh` parent — rail and
detail scrolling both die.

An investigation pass reported that inserting siblings keeps the selector intact. That
is true for *siblings*, and false for the structure this phase actually builds, because
the panel wrapper adds a level. Verified by reading `gui/src/styles.css:399-405`
directly. Recording it because the wrong version of this claim would have shipped a
broken layout that typecheck and tests cannot see.

### Fix

Make the panel wrapper the flex child and let the shell fill it:

```diff
-.main-inner.main-inner--combos > .combos-workspace-shell {
+.main-inner.main-inner--combos > .models-tab-panel--fill,
+.main-inner.main-inner--combos .models-tab-panel--fill > .combos-workspace-shell {
   flex: 1 1 auto;
   min-height: 0;
   height: 100%;
   display: flex;
   flex-direction: column;
 }
```

The header and strip need horizontal padding back, since `.main-inner--combos` zeroes
the container's:

```css
.main-inner--combos > .page-head,
.main-inner--combos > .page-tabs { padding-inline: 36px; flex-shrink: 0; }
@media (max-width: 760px) {
  .main-inner--combos > .page-head,
  .main-inner--combos > .page-tabs { padding-inline: 18px; }
}
```

`flex-shrink: 0` matters: without it the header is a flex item in a fixed-height column
and gets squeezed when the workspace wants room.

The two mobile rules (`gui/src/styles.css:1983`, `2020`) need no change — they set the
container height and padding, and both still apply.

## Why the modifier stays in App

`.main-inner` belongs to `App.tsx`; a page cannot add a class to its own container
without a callback or a portal. So App keeps the modifier and reads the tab (phase 2),
which is the smallest coupling available. The alternative — Models rendering its own
full-height wrapper inside the 980px column — does not work, because `.main-inner` has
`max-width: 980px` and normal padding until the modifier removes them.

## Inactive panels

The other two panels are `hidden`, which is `display: none` in the UA stylesheet, so
they occupy no flex space. No extra rule needed.

## MODIFY `gui/src/pages/Combos.tsx`

### Props

```diff
-export default function Combos({ apiBase }: { apiBase: string }) {
+export default function Combos({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
```

Default `true` keeps every existing call site and test honest.

### Gate the fetch

`Combos` fires three parallel fetches (`/api/combos`, `/api/config`, `/api/models`) on
subscription. It does **not** poll — no `pollMs` — so the risk of a permanently mounted
panel is a wasted cold load, not a background traffic leak. Still worth gating:

```diff
 const resource = useDataSurface<CachedCombosPage>(
   `combos-workspace:${apiBase}`,
   [apiBase],
   loadCombos,
-  { ... },
+  { ..., enabled: active },
 );
```

Care needed on the disabled render: a disabled resource yields `data: undefined` with
no skeleton and no error, and the existing fallback arrays would make `ComboWorkspace`
paint as a first-run empty state. So the disabled case must return the skeleton, not
the empty workspace. This is the one real trap in the phase.

### Pre-existing defect found while reading

`loadCombos` takes no `AbortSignal` and none of its three `fetch` calls pass one, so
resource cleanup cannot cancel them. Harmless today because the page only unmounts on
navigation; more visible once the panel mounts lazily. Threading the signal through is
a two-line change and belongs here rather than in a separate unit — it is the same code
being touched, and leaving a known un-cancellable fetch behind while explicitly adding
lifecycle control would be incoherent.

### Dialogs

Add, Remove, and Unsaved use native `showModal()`. A dialog in the browser's top layer
is not clipped by an ancestor's `hidden`. Whether an open dialog can survive a tab
switch depends on whether `hidden` on an ancestor closes it — **this must be checked in
the browser, not reasoned about.** If a modal does survive, the fix is to close open
dialogs when `active` goes false.

## MODIFY `gui/src/components/combo-workspace-detail-panel.tsx` — inner tabs

Currently `combos-workspace-tabs` / `combos-workspace-tab` with `role="tablist"` and
`aria-selected`. Not `.page-tabs`, but visually the same underline vocabulary, so under
the page strip it reads as two stacked underline rows — the pattern Primer names
directly.

Demote to a pill, following `.segmented.models-segmented` at `Models.tsx:924`:

```diff
-<div className="combos-workspace-tabs" role="tablist">
-  <button role="tab" aria-selected={tab === "config"}
-          className={`combos-workspace-tab${tab === "config" ? " combos-workspace-tab--active" : ""}`}>
+<div className="segmented combos-workspace-segmented" role="tablist">
+  <button role="tab" aria-selected={tab === "config"}
+          className={`btn btn-sm ${tab === "config" ? "btn-primary" : "btn-ghost"}`}>
```

**Roles stay `tablist`/`tab`/`aria-selected`.** The existing markup controls a real
`role="tabpanel"`, so this is a tab set wearing pill styling — not a filter. The
`radiogroup` precedent in `models-segmented` is for filters that control no panel; using
it here would misdescribe the widget. Pills are a visual change only.

`.segmented` has no standalone declaration in the GUI; every use pairs it with a
concrete class. So `styles-combos-workspace.css` gets `.combos-workspace-segmented`
mirroring `.models-segmented` (`styles-models-workspace.css:274-291`), and the four
underline rules at `styles-combos-workspace.css:220-248` are removed.

## Tests

No existing test references `#combos`, `main-inner--combos`, the shell classes, or a
`page === "combos"` branch — the route move breaks nothing and is also covered by
nothing. New assertions in `tests/models-workspace-tabs.test.ts`:

- `Combos.tsx` accepts `active` and passes `enabled` to its data surface.
- `Combos.tsx` forwards a signal into `loadCombos`.
- `combo-workspace-detail-panel.tsx` no longer contains `combos-workspace-tab--active`
  and does contain `segmented`.
- `styles.css` contains the `models-tab-panel--fill` rule (the layout contract is CSS,
  so this is the only place a test can hold it).

## Verification

Four gates, plus browser observation focused on this phase's two unknowns: does the
workspace still fill the viewport under the header and strip, and does an open modal
survive a tab switch. Both are invisible to typecheck and tests.
