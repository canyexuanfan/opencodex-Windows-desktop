# Phase 4 — Routing panel, Claude row, i18n, close-out

Routing is an ordinary scrolling page, so it drops into the third slot with no layout
negotiation. Then the duplicate Claude row goes and takes `isNavEntryActive` with it.

**Scope shrank after audit round 1.** The Routing NAV row and the tab-shell i18n keys
moved to phase 2 — a NAV entry is typed `Page`, so it cannot outlive the union member it
names. What is left here: the Routing panel itself, the Claude row, the remaining i18n,
and render grounding.

## MODIFY `gui/src/pages/RoutingProfiles.tsx`

### Two corrections about who actually polls

The goal statement claimed Routing "keeps fetching analytics." **Wrong.** `load()` runs
once from a zero-delay timeout (`RoutingProfiles.tsx:243-246`); everything else is
user-initiated. No interval, no `pollMs`. Combos is the same — three fetches on
subscription, no poll.

But the audit found the leak was real and in the panel neither the goal nor the first
draft examined: **Models itself polls**, `pollMs: 10_000` (`Models.tsx:271`) plus a
second 10-second `setInterval` for V2 (`Models.tsx:302`). That gating moved to phase 2.

So `active` here has a smaller job: stopping a cold load the user never asked for, and
cancelling one already in flight. Stating the smaller true reason rather than the larger
false one — the false one would justify machinery this phase does not need, and it also
pointed attention away from the component that genuinely had the problem.

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

That alone is **not** sufficient, and the first draft's claim that it was is false
(audit B4). `loadGenerationRef` only advances when a *new* load starts; hiding the tab
never bumps it, and the four fetches take no `AbortSignal`. So a load in flight when the
user switches away still lands and writes state into a hidden panel. The cleanup must
invalidate the generation on deactivate, and the fetches must carry a signal.

### Header

`RoutingProfiles` renders its own `page-head` with an `h2` (`routing.title`) — a second
page title under the Models header. The first draft said it "becomes an `h3` carrying
only the action buttons," which is incoherent: a heading cannot carry buttons.

Decision: **the panel heading is removed.** Create/Retry move into a plain toolbar row,
and `routing.subtitle` becomes the tab's `page-sub`. The Models header is the only title
on the page.

`gui/tests/routing-profiles.test.tsx:175` asserts the literal "Routing Intelligence
(beta)" and `[data-page="routing"]`; both change with this decision. The test follows the
design, not the reverse — but the string does not vanish from the product, it becomes the
tab label and the subtitle.

### Count callback

`onCountChange` (same shape as Combos, phase 3) reports `profiles.length` to the shell.
Without it the tab has no profile count and the discoverability mitigation below is
undeliverable.

## MODIFY `gui/src/App.tsx` — the sidebar payoff

The Routing row already went in phase 2. What is left is the duplicate:

```diff
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

`en`, `ko`, `ja`, `zh`, `ru`, `de`. The tab labels and `models.tabsLabel` shipped in
phase 2 (the strip cannot render without them). Remaining here: the split subtitles.

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

- NAV has nine entries; no `activeHashes`; `isNavEntryActive` is gone.
- **`gui/tests/sidebar-claude-entry.test.ts` is deleted.** It asserts the exact row this
  phase removes (`:18`), so it cannot be amended — the behaviour it guards is gone. Any
  still-valid part (the sidebar carries no mutation) moves into the NAV test.
- Every new i18n key exists in all six locales.
- Hiding the Routing tab mid-load leaves no state written by the in-flight request.
- The Routing tab count matches the profile list after a create and a delete.

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
