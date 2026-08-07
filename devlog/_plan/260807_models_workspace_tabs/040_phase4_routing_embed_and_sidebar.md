# Phase 4 — Routing panel, sidebar cleanup, i18n, close-out

The easy panel and the payoff. Routing is an ordinary scrolling page, so it drops into
the third slot with no layout negotiation. Then the sidebar loses its two rows and the
correction function that existed only to serve them.

## MODIFY `gui/src/pages/RoutingProfiles.tsx`

### Correction to an earlier assumption

The goal statement for this unit claimed Routing "keeps fetching analytics" and that a
hidden panel would leak background traffic. **That is wrong.** `load()` runs exactly
once, from a zero-delay timeout in a `useEffect` keyed on `load`
(`RoutingProfiles.tsx:243-246`); every other call is user-initiated (Retry, save,
create, delete). There is no interval and no `pollMs`. Combos is the same: three
parallel fetches on subscription, no poll.

So the `active` prop's real job is **not** stopping a traffic leak. It is stopping a
*cold load the user never asked for*: without it, opening `#models` would immediately
fetch `/api/routing-profiles`, `/api/routing-analytics`, `/api/config`, `/api/models`,
plus the three Combos endpoints, for two panels that are not on screen. Lazy mounting
already prevents most of that; `active` closes the gap for the panel that was mounted
earlier and then hidden.

Stating the smaller true reason rather than the larger false one, because the false one
would justify machinery this phase does not need.

### Props

```diff
-export default function RoutingProfiles({ apiBase }: { apiBase: string }) {
+export default function RoutingProfiles({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
```

```diff
 useEffect(() => {
+  if (!active) return;
   const timer = window.setTimeout(() => void load(), 0);
   return () => window.clearTimeout(timer);
-}, [load]);
+}, [active, load]);
```

The existing `loadGenerationRef` already discards responses from a superseded load, so
a fetch in flight when the tab is hidden cannot write stale state.

### Header

`RoutingProfiles` renders its own `page-head` with an `h2` (`routing.title`). Inside a
panel that is a second page title under the Models header, so the `h2` becomes an `h3`
carrying only the action buttons, and `routing.subtitle` moves into the tab's `page-sub`.

## MODIFY `gui/src/App.tsx` — the sidebar payoff

```diff
-  { id: "routing", tkey: "nav.routing", Icon: IconRoute },
   { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
-  {
-    id: "integrations",
-    tkey: "nav.claude",
-    Icon: IconTerminal,
-    subPath: "claude",
-    activeHashes: ["integrations/claude"],
-  },
   { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
```

With no two rows resolving to one page, `isNavEntryActive()` has nothing left to
correct and is deleted along with `activeHashes` and `subPath` on `NavEntry`. Rows go
back to `entry.id === page`.

> `subPath` is still used by the sidebar update button (`navigateToPage("dashboard",
> "update")`), which is a `useAppRouteState` parameter, not a `NavEntry` field. Only the
> `NavEntry` members go.

Eleven rows to nine: Dashboard, Codex Auth, Providers, Models, Subagents, Logs & Debug,
Usage, Storage, Integrations.

### The cost, stated plainly

Routing (beta) loses discoverability. It is a young feature and moving it one level in
means fewer people stumble onto it. Mitigations: the tab strip is visible on the Models
page the moment anyone opens it, the tab carries a profile count, and the Models
subtitle names routing directly. This is a real trade, not a free win.

Claude is different — it loses nothing. The Integrations tab it pointed at is unchanged
and `#integrations/claude` still resolves; only the duplicate shortcut is gone.

## i18n — six locales

`en`, `ko`, `ja`, `zh`, `ru`, `de`. New keys:

| Key | en |
|-----|-----|
| `models.tab.catalog` | `Models` |
| `models.tab.combos` | `Combos` |
| `models.tab.routing` | `Routing (beta)` |
| `models.tabsLabel` | `Model surfaces` |
| `models.subtitle.catalog` | (existing `models.subtitle`, trimmed) |
| `models.subtitle.combos` | one line on ordered failover / round-robin |
| `models.subtitle.routing` | (from `routing.subtitle`) |

`nav.combos` stays — the rail title inside the Combos workspace uses it. `nav.routing`
stays as the tab label source. `nav.claude` becomes unused in `App.tsx` but is still
referenced by the Integrations tab list; verify before deleting anything.

The current `models.subtitle` is four lines and reads as a page description. A page
with tabs has no single description, so it splits: the catalog keeps the visibility and
cache-invalidation sentences; combos and routing get one line each.

## Tests

- NAV has nine entries; no `activeHashes`; `isNavEntryActive` is gone from `App.tsx`.
- Every new i18n key exists in all six locales (extend the existing parity test if one
  covers this; otherwise assert directly).
- `RoutingProfiles.tsx` accepts `active` and guards its load effect.
- `Models.tsx` mounts both `Combos` and `RoutingProfiles`.

## Render grounding (C-RENDER-GROUNDING-01)

Static gates cannot see any of this. Against the running dashboard at
`http://127.0.0.1:10100`, driven in a real browser with screenshots read back:

1. `#models` — catalog paints, three tabs, counts correct.
2. Click Combos — full-bleed workspace fills the viewport under the header and strip;
   rail scrolls independently. **The phase-3 layout risk lands here.**
3. Click Routing — profiles and analytics paint; no second page title.
4. Reload on each of the three hashes — the tab survives.
5. Back/Forward across all three — no trapped hash, no flicker to catalog.
6. Arrow Left/Right/Home/End on the strip — focus and selection move together.
7. `#combos` and `#routing` directly — each redirects and lands on the right tab.
8. Open a combo, type into the draft, switch tabs, come back — the draft survives.
9. Open the Add-combo modal, switch tabs — confirm the dialog does not float over
   another tab's content (the phase-3 top-layer question).
10. Sidebar shows nine rows; no row lights while another owns the hash.

Anything observation reveals gets fixed before D. A screenshot produced but not read is
not observation.

## Close-out

Unit moves to `devlog/_fin/` once the outcome is recorded. Commits stay local — push
and PR need explicit approval.
