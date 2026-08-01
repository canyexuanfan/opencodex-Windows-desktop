# 020 — Single-column layout

Dependency position: **first**. Revised at the A gate — see `000` §"Why the
layout phase runs first". This phase treats `ClientConfigPanel` as an opaque
child: it moves the node without reading it, so it does not depend on `010`,
while `010` does depend on the final container width this phase establishes.

Base: `eeef7012`. At this phase's P gate, re-read the current tree — which for
this phase is the **pre-`010`** source, since this phase runs first — and rebase
every citation. The original instruction to read "the landed `010` diff" was an
artifact of the superseded ordering.

## Scope

IN

- Collapse `.awi-overview` from two columns to one.
- Model catalog and auth matrix render at full shell width.
- Remove the stacked-chip workaround now that the row has width.
- Rail disposition (see §Rail decision).
- Section ordering and, if the rail is folded, a `SectionTabs` strip.
- Update `gui/tests/apikeys-layout.test.ts` contracts.

OUT

- Panel internals. This phase runs before `010`, so what it moves is the
  **current** `ClientConfigPanel`, unchanged and unread; `010` then rebuilds that
  panel's internals inside the container this phase establishes.
- The catalog's `min(574px, 58vh)` cap and its `overscroll-behavior: auto`
  wheel-handoff rule. Both stay exactly as they are.
- Attribution semantics, key CRUD contracts, the auth matrix's data source.
- Any `src/` change.

## Rail decision

`002` §7 left this open with a stated lean. It is resolved **here**, at this
phase's P, with the reviewer's verdict recorded — not assumed now.

The decision rule, fixed in advance so the outcome is not rationalized after the
fact:

> Fold the rail into a table if and only if the table can carry every fact the
> rail row carries (name, 7-day requests, last used) plus the two the detail
> pane adds (prefix, created), without a horizontal scroller at 1280x720, and
> with delete/rename reachable in at most one extra interaction.

If it can, the rail goes and the tab is genuinely one column — the literal ask.
If it cannot, the rail stays and this phase delivers a single-column *overview*
with the rail retained, which still removes one of the three bands.

A five-column table of `name · prefix · 7d requests · last used · actions` at
~1130px of usable width is not a demanding layout, so the expected outcome is
fold. That expectation is not evidence; the P-phase measurement is.

## File change map

| Path | Action |
|------|--------|
| `gui/src/styles-apikeys-workspace.css` | MODIFY — see §CSS action map; the range is **split**, not deleted wholesale |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY — one ordered section list; rail per §Rail decision |
| `gui/src/pages/api-keys-panels.tsx` | MODIFY — key table when the rail folds; otherwise untouched |
| `gui/src/pages/api-keys-endpoints-panel.tsx` | MODIFY — matrix no longer needs its horizontal scroller at desktop widths |
| `gui/src/components/apikeys-workspace/ApiKeyDetailDialog.tsx` | ADD, conditional on the rail folding — follows the existing native-dialog pattern in `codex-account-reset-modal.tsx:29-51`, not `010` |
| `gui/src/i18n/*` | MODIFY — only if the rail folds (table column headers). Any key change makes `bun run lint:i18n` a required gate for this phase |
| `gui/tests/apikeys-layout.test.ts` | MODIFY — per §Test changes |
| `gui/tests/apikeys-workspace.test.tsx` | MODIFY — rail/detail assertions if the rail folds |

## CSS action map

The first draft said "delete `:183-268`". The audit caught that this range
contains load-bearing rules the same document promises to preserve. Split
explicitly:

Line ranges verified against `styles-apikeys-workspace.css` at `eeef7012`. The
audit found two errors in the first split — a block of column-agnostic shared
rules swept into a REMOVE bucket, and a sticky block whose end line was short by
four — so each range below is stated separately rather than in a sweep.

| Range | Selector | Action | Why |
|-------|----------|--------|-----|
| `:183-190` | `.awi-overview` grid | REPLACE — single track | The two-column split itself |
| `:192-198` | `.awi-overview-left, .awi-overview-right` flex | REMOVE | Column containers cease to exist |
| `:200-203` | `.awi-overview-left > .panel, .awi-overview-right > .panel` margin reset | RETARGET to the single container | Still needed; the selector is column-named |
| `:205-207` | `.awi-overview-left > .panel` flex | REMOVE | Column-scoped |
| **`:209-220`** | `.awi-overview .api-panel`, `.api-auth-list`, `.api-endpoints` | **KEEP UNCHANGED** | Column-agnostic — these are scoped to `.awi-overview` itself, not to a side. Touching them changes panel padding and endpoint spacing for no reason |
| `:222-225` | `.awi-overview-left > .panel > p.muted.small` | RETARGET | Prose spacing; selector rename only |
| `:227-230` | `.awi-overview-right > .panel:not(.api-models-panel)` | REMOVE | Column-scoped |
| **`:231-241`** | `.awi-overview-right > .api-models-panel { overflow: visible }` | **RETARGET, NEVER DELETE** | The browser-measured wheel-handoff fix. Deleting it silently re-traps the wheel and no static test catches it |
| `:243-248` | models-panel flex children | RETARGET | Selector rename only |
| **`:254-262`** | `.api-models-scroll` cap + `overscroll-behavior: auto` + `scrollbar-gutter` | **RETARGET, NEVER DELETE** | The tab's only legitimate cap; the scroll test asserts its exact value |
| **`:265-272`** | sticky `thead th` | **RETARGET, NEVER DELETE** | A long catalog without it becomes unlabelled columns |
| `:405-419` | `.api-model-actions` | MODIFY — see §The chip rule | Not a plain deletion |

Every RETARGET is a selector rename that must keep the declaration block
byte-identical. Re-verify these line numbers at this phase's P gate; the file
will have moved if any earlier work lands first.

## The chip rule

The first draft planned to assert "no `flex-direction: column`". The audit
demonstrated that assertion is **false-green**: `.api-model-actions` at `:409`
has no `flex-direction` today, so the test would pass against the unmodified tree
and prove nothing.

The actual mechanism is `flex-wrap: wrap` inside a ~430px column. The fix is
width, and the observable is that the actions no longer wrap.

Required discipline: **drive the new assertion red first.** Write it, run it
against the pre-change tree, confirm it fails, then implement. An assertion that
has never been red is not evidence. The static test asserts the wrap rule is
removed or overridden; the rendered check at 1280px is what actually proves one
line, and it is mandatory.

## Section order

```
API Access  ·  base URL + primary action
─ Keys              (table or rail-backed detail)
─ Connect a client  (010's rows)
─ Endpoints & auth  (full-width matrix)
─ Models            (full-width catalog, capped, sticky header)
─ Examples          (curl)
```

Rationale: identity first (you need a key), then transport (where to point a
client), then reference (what the endpoints accept), then inventory (what to
call), then examples. Each step is a precondition of the next, which is also why
`ApiKeysUsagePanel` moves from third to last — its current position is an
artifact of column packing, not of reading order.

A `SectionTabs` strip (`gui/src/components/section-tabs.tsx`, already used by
Usage, Logs, Subagents) is added **only if** the folded page exceeds roughly two
viewport heights at 1280x720. Measured in C, not assumed here.

## Test changes

| Test | Change | Guard carried |
|------|--------|---------------|
| `apikeys-layout.test.ts:157` "left column keeps its order" | REPLACE with a single ordered section-list assertion | Deterministic section order |
| `apikeys-layout.test.ts:118` "page owns vertical scroll" | KEEP verbatim | Exactly one cap, exact value, `overscroll-behavior: auto`, sticky header |
| `overflow: visible` assertion on the models panel | RETARGET to the new selector | The browser-measured wheel handoff |
| `apikeys-layout.test.ts:32` container-query assertions | UPDATE breakpoints | Stacking behavior at narrow widths |
| NEW "the overview is a single column" | ADD | The ask, made enforceable |
| NEW "catalog actions do not wrap" | ADD, **driven red first** | The real mechanism (`flex-wrap`), not the strawman (`flex-direction`) |

### Rail-fold test ledger (mandatory if the rail folds)

`gui/tests/apikeys-workspace.test.tsx` carries four behavioral contracts the
first draft did not map. Folding the rail without this ledger would delete them
silently. Each needs a named destination before any code moves:

| Existing contract | Destination after fold |
|---|---|
| Pending-secret preservation across selection | Same behavior in the table's row-activation path |
| Delete-confirm reset and return behavior | The key detail dialog's confirm flow |
| Stale selected-key fallback | Table selection state when the selected key disappears |
| Truncated-attribution wording | The detail dialog's attribution section |

If any contract has no honest destination, the rail does **not** fold — that
outcome is a legitimate result of the §Rail decision rule, not a failure.

## Accept criteria

1. `.awi-overview` declares a single column track at every width.
2. At 1280x720 rendered: the auth matrix shows all four columns with no
   horizontal scrollbar.
3. At 1280x720 rendered: a catalog row shows `Copy ID` and every protocol chip
   on one line.
4. The catalog remains the only `max-height` in the stylesheet, still
   `min(574px, 58vh)`, still `overscroll-behavior: auto`, still sticky-headed.
5. Wheel handoff at the end of the catalog still scrolls the page.
6. Sections appear in the §Section order sequence.
7. If the rail folded: every fact the rail carried is present in the table or its
   detail dialog, delete/rename remain reachable, and all four contracts in the
   §Rail-fold test ledger have live replacements.
8. The GUI gate set passes: from `gui/`, `bun test tests`, `bun run lint`, and
   `bun run build`.

### Activation scenarios

| Conditional path | Trigger in C | Observable effect |
|------------------|--------------|-------------------|
| Narrow-width stacking | Render at 720px | Sections stack; no horizontal page scroll |
| Catalog wheel handoff | Scroll to the catalog's end, keep scrolling | Page scrolls; catalog does not trap |
| `SectionTabs` scroll-spy (if added) | Scroll past a section boundary | Active tab follows the heading |
| Empty-keys state | Render with zero keys | Generate action visible without scrolling |

## Verifier commands

All commands run from `gui/` with this checkout's Bun
(`../node_modules/.bin/bun`), per `gui/AGENTS.md:42`.

| Command | Reads this phase's target? |
|---------|---------------------------|
| `bun test tests` | Yes — `apikeys-layout.test.ts` reads the stylesheet as text; `apikeys-workspace.test.tsx` mounts the workspace |
| `bun run lint` | Yes |
| `bun run build` | Yes — `tsc -b && vite build`; this, not root `typecheck`, is what typechecks the GUI |
| `bun run lint:i18n` | Required **iff** the rail folds and adds locale keys (`gui/AGENTS.md:53`); a no-op otherwise |
| Rendered observation at 1280x720 | Yes, and it is the only check that can see criteria 2, 3, and 5 |

Root `bun run typecheck` is **not** listed: `tsconfig.json:15` includes only
`src`, so it cannot fail on a GUI change (`001` §7).

Criteria 2, 3, and 5 are unreachable by static gates. A green suite with a
clipped matrix is exactly the failure this phase exists to fix, so the rendered
observation is mandatory (C-RENDER-GROUNDING-01) and its screenshot is persisted
to this unit.

## Bypass record

- Tier: E8 (test suite).
- Executing surface: `bun run test`.
- Known bypass: the layout assertions read CSS as text, so a rule moved to an
  inline style or a different file passes them while the rendered page regresses.
- Residual risk: real; the rendered check is what actually covers it, and it is
  human-run.
- Wording: early warning, not enforcement. Final enforcement layer: none.
