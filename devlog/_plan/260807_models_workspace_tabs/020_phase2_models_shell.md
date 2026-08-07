# Phase 2 — Models shell

The atomic phase: the `Page` union loses `combos` and `routing`, the tab strip appears,
and the panels that replace those pages mount. Splitting any of it out would leave a
commit where a page has been deleted but its replacement does not exist.

## MODIFY `gui/src/app-routing.ts` — remove the two pages

```diff
 export type Page =
   ...
   | "models"
-  | "combos"
   | "subagents"
   ...
-  | "integrations"
-  | "routing";
+  | "integrations";
```

Same two entries out of `VALID_PAGES`. Then the legacy ids in `readPageFromHash`,
beside the existing `debug` line:

```ts
// Legacy: Combos and Routing used to be standalone pages; both are Models tabs now.
if (pageId === ("combos" as Page) || pageId === ("routing" as Page)) return "models";
```

and the redirects in `resolveAppHashChange`, directly after the `debug` branch:

```ts
if (rawHash === "combos" || rawHash.startsWith("combos/")) {
  return { page: "models", replaceTo: "models/combos" };
}
if (rawHash === "routing" || rawHash.startsWith("routing/")) {
  return { page: "models", replaceTo: "models/routing" };
}
```

The `startsWith` arm is not decoration: `#routing/foo` from an old bookmark must reach
the Routing tab rather than be normalized to a bare page that drops the destination —
the exact failure the file's `#api` comment already documents.

## MODIFY `gui/src/App.tsx`

`PAGE_TKEY` loses its `combos` and `routing` keys (the compiler demands it — the record
is keyed by `Page`).

Render block:

```diff
-  {page === "models" && <Models apiBase={API_BASE} />}
-  {page === "combos" && <Combos key={API_BASE} apiBase={API_BASE} />}
+  {page === "models" && <Models key={API_BASE} apiBase={API_BASE} />}
   ...
-  {page === "routing" && <RoutingProfiles key={API_BASE} apiBase={API_BASE} />}
```

`Combos` and `RoutingProfiles` imports move out of `App.tsx` into `Models.tsx`.

The full-bleed modifier stops asking about the page and starts asking about the tab:

```diff
-<div className={`main-inner${page === "combos" ? " main-inner--combos" : ""}`}>
+<div className={`main-inner${modelsTab === "combos" && page === "models" ? " main-inner--combos" : ""}`}>
```

where `modelsTab` comes from a `readModelsTab()` state synced on `hashchange` /
`popstate`, the same listener pair `useAppRouteState` already installs.

> This is the one piece of tab knowledge that has to live in App rather than in
> Models: the `.main-inner` element is App's, and phase 3 explains why the modifier
> cannot simply move inside the page.

NAV rows and `isNavEntryActive` are **not** touched here — that is phase 4, so the
sidebar keeps working while the page is rebuilt.

## MODIFY `gui/src/pages/Models.tsx`

### Tab state

```tsx
const [tab, setTab] = useState<ModelsTab>(readModelsTab);
const [mounted, setMounted] = useState<ReadonlySet<ModelsTab>>(() => new Set([readModelsTab()]));

const activateTab = (next: ModelsTab) => {
  setTab(next);
  setMounted(current => (current.has(next) ? current : new Set([...current, next])));
};
```

Copied deliberately from `Integrations.tsx`: panels mount lazily and then stay mounted
so a half-typed combo draft survives a tab hop, and the accumulation happens in the
event handler rather than an effect so a switch costs one render, not two.

`hashchange` + `popstate` listeners call `activateTab(readModelsTab())`.

### Strip markup

`.page-tabs` / `.page-tab` / `.page-tab--active`, `role="tablist"`, roving tabindex,
`aria-selected`, `aria-controls`, and Arrow/Home/End — the wiring the APG requires and
that `Integrations.tsx` already implements. Each label carries a `.section-tab-meta`
count: `Models 35/273`, `Combos 3`, `Routing 2`. The class and its
`page-tab--active > .section-tab-meta` rule already exist in `styles.css`.

Counts come from data the page already holds — `effectiveVisibleCount` / `models.length`
for the catalog and `combos.length` from the existing `combosResource`. Routing's count
needs a profile list, which the Routing panel owns; until it reports one the meta is
omitted rather than rendered as `0`, because a wrong count is worse than none.

### Body split

Everything currently returned by the component — rail, controls, provider list, modals
— becomes the catalog panel body. The three panels are siblings, each `hidden` when
inactive (`hidden` per the APG examples, matching the existing Logs code).

The page header (`h2` + count) and the strip live above all three panels and stay
visible on every tab. The `page-sub` moves inside the catalog panel and gets split per
tab (phase 4 writes the copy).

## Test additions — `tests/models-workspace-tabs.test.ts`

- `VALID_PAGES` no longer holds `combos` or `routing`.
- `resolveAppHashChange("combos")` → `{ page: "models", replaceTo: "models/combos" }`;
  same for `combos/x`, `routing`, `routing/x`.
- `Models.tsx` contains `role="tablist"`, three `page-tab` entries, and `hidden={`.
- `App.tsx` no longer contains `page === "combos"` or `page === "routing"`.

## MODIFY `tests/routing-intelligence-ui.test.ts`

Now genuinely stale, and the compiler cannot catch a string assertion:

```diff
-  expect(VALID_PAGES.has("routing")).toBe(true);
-  expect(readPageFromHash("routing")).toBe("routing");
-  expect(hashBelongsToPage("routing", "routing")).toBe(true);
-  expect(resolveAppHashChange("routing").replaceTo).toBeNull();
+  expect(readPageFromHash("models/routing")).toBe("models");
+  expect(hashBelongsToPage("models/routing", "models")).toBe(true);
+  expect(resolveAppHashChange("models/routing").replaceTo).toBeNull();
+  expect(resolveAppHashChange("routing")).toEqual({ page: "models", replaceTo: "models/routing" });
```

and `expect(app).toContain('page === "routing"')` becomes an assertion that
`Models.tsx` mounts `RoutingProfiles`.

## Verification

All four gates green. This is the phase where a mistake shows up as a blank page, so
the browser check starts here even though the formal render-grounding gate is phase 4:
load `#models`, `#models/combos`, `#models/routing` and confirm each paints.
