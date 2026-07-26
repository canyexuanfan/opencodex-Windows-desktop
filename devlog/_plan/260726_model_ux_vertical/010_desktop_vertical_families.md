# 010 — WP1: vertical family stack, Opus on top, collapsible headers

Direction and dials come from `000_plan.md`. This doc is the implementation contract.

## Scope

IN: family container geometry, family-level collapse, collapsed-header legibility,
persistence, the locale keys those need.
OUT: the per-model row's internal disclosure (WP2), anything Grok (WP3/WP4).

## NEW — `gui/src/pages/claude-desktop-collapse.ts`

Pure helpers, testable without a DOM. Mirrors the storage idiom in
`gui/src/pages/models-shared.ts:101-116` but with its own key, because Desktop families
and Models providers are different namespaces and must not collide.

```ts
/**
 * Collapse persistence for the Claude Desktop family stack.
 *
 * Separate from the Models page's provider-collapse key on purpose: the two surfaces
 * collapse different things, and sharing one key would make collapsing "opus" here
 * collapse a provider literally named "opus" there.
 *
 * Collapse is view state. It never reaches the profile: `modelsByFamily` and
 * `effectiveDefaults` keep seeing every model (see claude-desktop-lane.ts).
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "ocx.claudeDesktop.collapsedFamilies.v1";

/** Opus is the family users actually assign; it starts open, the rest start collapsed. */
export const DEFAULT_COLLAPSED_FAMILIES = ["fable", "sonnet", "haiku"] as const;

export function readCollapsedFamilies(storage?: StorageLike): Set<string> {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!store) return new Set(DEFAULT_COLLAPSED_FAMILIES);
  try {
    const saved = store.getItem(KEY);
    // No stored preference is NOT "everything open": a first visit should show the
    // Opus lane and a compact index of the rest, which is the whole point of the change.
    if (saved === null) return new Set(DEFAULT_COLLAPSED_FAMILIES);
    const parsed = JSON.parse(saved) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set(DEFAULT_COLLAPSED_FAMILIES);
  }
}

export function writeCollapsedFamilies(collapsed: ReadonlySet<string>, storage?: StorageLike): void {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify([...collapsed]));
  } catch {
    /* quota / private-mode — collapse is a preference, never a hard failure */
  }
}

export function toggleInSet(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}
```

## MODIFY — `gui/src/pages/ClaudeDesktop.tsx`

### 1. Import and state

```diff
 import { LANE_PAGE, laneView } from "./claude-desktop-lane";
+import { readCollapsedFamilies, toggleInSet, writeCollapsedFamilies } from "./claude-desktop-collapse";
+import { IconChevron } from "../icons";
```

Next to the existing `laneSearch`/`laneLimit` state (currently `:114-116`):

```diff
+  // View state only — see the lane comment above: collapse must never narrow the
+  // source arrays that effectiveDefaults reads.
+  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(readCollapsedFamilies);
```

and the toggle, next to `moveModel`:

```diff
+  const toggleFamily = (family: Family) => {
+    setCollapsedFamilies(current => {
+      const next = toggleInSet(current, family);
+      writeCollapsedFamilies(next);
+      return next;
+    });
+  };
```

### 2. Family section markup

`FAMILIES` is already `["opus", "fable", "sonnet", "haiku"]` (`:6`), so Opus-on-top
follows from the container becoming a vertical stack — no reordering code needed. The
container class changes so the CSS grid does not have to be overloaded:

```diff
-      <div className="claude-lanes" aria-label={t("claudeDesktop.assignmentsLabel")}>
+      <div className="claude-family-stack" aria-label={t("claudeDesktop.assignmentsLabel")}>
```

The lane header becomes a real disclosure button. Replacing the current
`<header className="claude-lane-head">` block (`:334-352`):

```tsx
const isCollapsed = collapsedFamilies.has(family);
const familyDefault = effectiveDefaults[family];
return (
  <section
    key={family}
    className={`claude-lane${isCollapsed ? " collapsed" : ""}`}
    aria-labelledby={`claude-lane-${family}`}
    onDragOver={event => event.preventDefault()}
    onDrop={event => dropOnLane(event, family)}
  >
    <header className={`claude-lane-head${isCollapsed ? "" : " open"}`}>
      <button
        type="button"
        className="claude-lane-toggle"
        aria-expanded={!isCollapsed}
        aria-controls={`claude-lane-body-${family}`}
        onClick={() => toggleFamily(family)}
      >
        <IconChevron
          className="claude-chevron"
          width={14}
          height={14}
          aria-hidden="true"
          style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
        />
        <h3 id={`claude-lane-${family}`}>{t(FAMILY_KEYS[family])}</h3>
        <span className="claude-lane-count">
          {t(all.length === 1 ? "claudeDesktop.modelCountOne" : "claudeDesktop.modelCountMany", { count: all.length })}
        </span>
        {/* Collapsed legibility: the resolved default is the one thing a user opens a
            lane to check, so it must be readable without opening it. */}
        {familyDefault && (
          <code className="claude-lane-default" title={familyDefault}>{familyDefault}</code>
        )}
      </button>
      {/* Warnings stay OUTSIDE the fold — ux-states.md §5 forbids hiding state the
          user has to act on. */}
      {all.length > 0 && profile.defaults[family] === null && (
        <span className="claude-default-needed">{t("claudeDesktop.chooseDefault")}</span>
      )}
      {familyDefault && familyDefault !== profile.defaults[family] && (
        <span className="claude-default-needed" title={familyDefault}>{t("claudeDesktop.temporaryDefault")}</span>
      )}
    </header>
    {!isCollapsed && (
      <div id={`claude-lane-body-${family}`}>
        {/* existing search input + .claude-lane-models block, unchanged */}
      </div>
    )}
  </section>
);
```

Note the header count switches from `modelsByFamily[family].length` to `all.length` —
they are the same array (`const all = modelsByFamily[family]`), this only removes the
repeated lookup.

### 3. Drag-and-drop while collapsed

`onDrop`/`onDragOver` stay on the `<section>`, so a collapsed family is still a valid
drop target — dropping onto its header row moves the model there. That is the
behaviour the current code already has at the lane level (`:329-333`); collapsing must
not remove it.

## MODIFY — `gui/src/styles.css`

Replace the 4-column grid with a vertical stack and add the toggle/summary styling.
Existing `.claude-lane*` rules stay; only the container geometry and the new header
internals change.

```diff
-.claude-lanes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 12px; }
+/* Vertical family stack: Opus first, one collapsible section per Claude family.
+   Replaces the 4-column kanban — with a real catalog, three lanes sat empty beside
+   one 4000px column. */
+.claude-family-stack { display: flex; flex-direction: column; gap: 10px; }
```

```css
.claude-lane-toggle {
  display: flex; flex: 1; align-items: baseline; gap: 10px; min-width: 0; padding: 0;
  border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left;
}
.claude-chevron { flex-shrink: 0; color: var(--muted); transition: transform var(--motion-fast); }
.claude-lane-count { color: var(--muted); font-size: 11.5px; }
.claude-lane-default {
  min-width: 0; overflow: hidden; color: var(--faint); font-size: 11px;
  text-overflow: ellipsis; white-space: nowrap;
}
.claude-lane-head.open { border-bottom: 1px solid var(--border-soft); }
.claude-lane.collapsed .claude-lane-head { border-bottom: 0; }
```

And the media queries that only existed to re-flow the grid:

```diff
-@media (max-width: 1200px) {
-  .claude-lanes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
-}
-
-@media (max-width: 900px) {
-  .claude-lanes { grid-template-columns: 1fr; }
-}
```

A vertical stack is already correct at every width, so the breakpoints are dead code.
The `.claude-lane-head` rule that sets `border-bottom` unconditionally
(`styles.css:1299-1302`) drops that property; `.open` now owns it.

## Locale keys

No new user-visible strings: the header reuses `claudeDesktop.modelCountOne/Many`,
`claudeDesktop.chooseDefault`, `claudeDesktop.temporaryDefault`. The toggle button's
accessible name is the family name it already renders, so no `aria-label` key is
needed. **WP1 therefore adds zero i18n debt** — verify with `bun run lint:i18n`
rather than assuming.

## TESTS

`gui/tests/claude-desktop-collapse.test.ts` (NEW):

- no stored value → Opus open, other three collapsed (`DEFAULT_COLLAPSED_FAMILIES`);
- a stored `[]` → everything open (an explicit user preference beats the default);
- `writeCollapsedFamilies` round-trips through a fake storage;
- a throwing `setItem` (private mode) does not throw out of the writer;
- corrupt JSON falls back to the default set, not a crash;
- `toggleInSet` adds/removes without mutating its input;
- the storage key is NOT the Models page key (regression guard against collision).

`gui/tests/claude-desktop-vertical.test.ts` (NEW, source-shape assertions in the style
of `gui/tests/grok-page.test.ts`):

- `ClaudeDesktop.tsx` no longer references `claude-lanes` and does reference
  `claude-family-stack`;
- the header renders `aria-expanded`;
- `styles.css` has no `grid-template-columns: repeat(4` for the family container.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-desktop-collapse.test.ts tests/claude-desktop-vertical.test.ts` | pass |
| `cd gui && bun run test` | pass |
| `bun run lint:gui` | clean |
| `bun run lint:i18n` | clean |
| `bun x tsc --noEmit` (root) + `gui` build typecheck | clean |
| headless render of `/#claude-desktop` | Opus section open at top, three collapsed sections beneath, chevrons rotated correctly |
