# 000 — 260726 model UX vertical: plan

## Objective

Make the two model-assignment surfaces (Claude Desktop, Grok Build) behave like the
Models page: a **vertical** list of collapsible groups where the important thing is
readable while collapsed, and detail is two clicks deep at most. Concretely, from the
user's brief:

1. Grok needs per-model **switches** (it is read-only today).
2. Claude Desktop must stop being a 4-column kanban; **Opus goes on top**, the other
   families stack under it.
3. Both surfaces get **vertical ordering + collapse**, and the model list opens via a
   **second level of disclosure** so the long catalog reads well.

Baseline: `dev` at `b4485706`, one commit ahead of `origin/dev`.

## Current shape, with the source located

**Claude Desktop.** `gui/src/pages/ClaudeDesktop.tsx:315-317` maps `FAMILIES` into
`.claude-lanes`, which `gui/src/styles.css:1294` declares as
`grid-template-columns: repeat(4, minmax(0, 1fr))` (2 columns under 1200px, 1 under
900px). Every model in a lane renders as a fully expanded card
(`ClaudeDesktop.tsx:369-425`): title, availability badge, context, effort badge, alias
field, default radio, and a move row — roughly 180px of vertical space each. With 23
models in Opus (the user's screenshot) that lane is a ~4000px column while Fable,
Sonnet and Haiku sit empty beside it. The density work in
`devlog/_plan/260726_gui_grok_improvements/040_desktop_model_density.md` added search +
a pager (`gui/src/pages/claude-desktop-lane.ts`) but kept the kanban geometry and the
always-expanded card, so the wall is shorter, not gone.

**Grok.** `gui/src/pages/Grok.tsx:88-113` renders a read-only `<table>` of the models
opencodex wrote into `~/.grok/config.toml`. The list itself is produced by
`src/grok/sync.ts:33-52`: every visible native slug plus every catalog-visible routed
model, injected by `src/grok/inject.ts:170` (`injectGrokConfig`). There is no
per-model choice anywhere in that path — the fence mirrors the whole visible catalog,
which is why the user sees a table with no controls.

**The pattern to copy.** `gui/src/pages/Models.tsx:614-628` is the in-app answer to
exactly this problem: a `.group-head` row with a chevron button carrying
`aria-expanded`, the group's counts still readable while collapsed, the body rendered
only when open, and collapse state persisted through
`readCollapsedProviders`/`writeCollapsedProviders` (`gui/src/pages/models-shared.ts:101-116`).
`gui/src/styles.css:561-563` already styles `.group-head` / `.group-head.open`.

## Design Read

```yaml
---
name: opencodex-model-assignment-surfaces
surface: expert control panel inside the local dashboard (Claude Desktop + Grok tabs)
colors: inherited — var(--surface), var(--border), var(--amber), var(--green)
typography: inherited — app sans for labels, var(--font-code) for routes/aliases
iconography:
  system: "in-repo gui/src/icons.tsx"
  weight: "regular"
  domain: "library-subset (IconChevron only)"
---
```

Reading this as: a **repeated-work operator panel** for someone who already knows what
a model route is, embedded in a dashboard with a settled visual language. The brief is
navigational ("접기 버튼 있는 model ux처럼 간편하게", "이중 펼침으로 모델리스트를
보기") — a density and disclosure problem, not a styling one.

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: UX-DIAL-PRESET-01 Dashboard/SaaS admin is 3/2/5; motion drops to 1 because
every interaction here is a discrete assignment, and the existing chevron rotation
(.12s) is the whole motion budget this app spends on disclosure.
```

**Lazy-user gate (UX-LAZY-01), applied in order.**

1. *Do nothing* — no. The 4-column kanban with 23 always-expanded cards in one lane is
   the reported problem.
2. *Delete* — the four families cannot go (they are Claude's real families), but the
   always-visible per-card detail can: alias, default radio and move control are
   inspect/edit affordances, not scanning information.
3. *Absorb* — the system already knows the answer to "which model matters here": the
   family default and availability. Surface those in the collapsed row so the user
   rarely needs to open anything.
4. *Demote* — everything else goes behind the second disclosure level.

**Progressive disclosure contract (UX-STATE-01 + `ux-states.md` §5).** Two levels,
both discoverable, nothing safety-critical hidden:

```
Opus  ▸  23 models · default: anthropic/claude-opus-5        ← level 1 collapsed
  ├ claude-opus-5      anthropic/claude-opus-5  [available] 1M   ← level 2 collapsed
  │   alias · use as default · move to ▾                          ← level 2 open
  └ …
Fable ▸  0 models · choose a default
Sonnet ▸ 0 models
Haiku ▸  0 models
```

Level 1 (family) stays open for Opus by default and reports count, default model and
any "choose a default"/"temporary default" warning **while collapsed** — a warning
hidden behind a fold would violate the rule against hiding state the user must act on.
Level 2 (model row) is collapsed by default and shows label, route, availability and
context; opening it reveals alias, the default radio, and the move control.

Do's: reuse `.group-head` + `IconChevron` + `aria-expanded`; persist collapse in
localStorage the way Models does; keep the Opus-first order fixed rather than sortable.
Don'ts: no new visual language, no motion beyond the existing chevron rotation, no
emoji, no collapsing the families into a wizard (the inverse failure for a
repeated-work tool), and no hiding the availability badge or default warnings behind a
fold.

## Invariant that constrains every phase

`gui/src/pages/ClaudeDesktop.tsx:110-113` and `claude-desktop-lane.ts:1-9` both state
it: view state is **render-only**. `modelsByFamily` and `effectiveDefaults` must keep
seeing every model, because `effectiveDefaults` picks the first *available* member as a
family's fallback — so a filter, a pager, or a collapse must never narrow the source
arrays. Collapse is strictly weaker than search here (it renders nothing at all), but
the same rule applies: no collapse state may reach `profile`, `defaults`, or the PUT
body.

## Grok: where a switch may live

`src/grok/inject.ts:170-200` refuses to write for non-loopback binds and preserves user
content byte-for-byte; the security review recorded in
`devlog/_plan/260726_grok_build_prod/` is the reason there is no web-reachable writer.
That decision stands: the switch must **not** write TOML from the management API.
Instead the selection is config state (`~/.codex/ocx/config.json` via `saveConfig`),
`syncGrokConfig` filters the model list by it, and re-applying goes through the same
`syncGrokConfig` → `injectGrokConfig` path that `ocx start`/`ensure`/`restart` use.
`gui/tests/grok-page.test.ts:12-19` currently asserts the page issues no writes; that
test encodes "no writer", so it must be rewritten deliberately in WP3/WP4 to assert the
narrower rule (writes go to `/api/grok/selection`, never to a TOML writer), not deleted.

## Loop-spec

- Loop archetype: spec-satisfaction. Each phase has a gate (`bun run typecheck`,
  `bun run test`, `gui bun run test`, `bun run lint:gui`, `bun run lint:i18n`,
  `bun run privacy:scan`) plus a rendered observation for the UI phases.
- Trigger: the user's brief above (Grok switch, Opus-on-top, vertical + collapse +
  two-level disclosure).
- Goal: both surfaces navigable at 25+ models without scrolling past detail the user
  did not ask for.
- Non-goals: releases, version bumps, `main`/`preview` promotion, provider adapters,
  Codex/Claude routing, breaking the version-1 desktop profile schema.
- Verifier: the gates above; `c-*` criteria in
  `.codexclaw/goalplans/opencodex-grok-claude-desktop-ux-models-2-work-p/goalplan.json`.
- Stop condition: all criteria met with captured evidence, or a terminal outcome
  (`BLOCKED` / `NEEDS_HUMAN` / `BUDGET_EXHAUSTED`) with evidence.
- Write scope: `gui/src/`, `gui/tests/`, `src/grok/`, `src/types.ts`,
  `src/server/management/`, `tests/`, this devlog unit.
- Bounds: local commits only; **no push without explicit approval** (LOOP-GIT-01).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` (this doc) | Roadmap + Design Read | — |
| WP1 | `010_desktop_vertical_families.md` | Vertical family stack, Opus on top, collapsible headers | — |
| WP2 | `020_desktop_row_disclosure.md` | Two-tier disclosure for model rows | WP1 |
| WP3 | `030_grok_selection_state.md` | Grok selection in config + management API + sync filter | — |
| WP4 | `040_grok_switch_ui_and_gates.md` | Grok switch UI in the shared idiom + full gates | WP3, WP1 |

Dependency order (PHASE-SPLIT-01), not effort order: WP1 establishes the vertical
container that WP2's row disclosure lives inside; WP3 creates the state and contract
that WP4's switches drive; WP4 also owns the closing gate run because it is the last
surface to change.

## Accept criteria

Mirrored 1:1 into the goalplan `criteria[]`:

- `c-docs` — this unit holds 000-range research plus a diff-level doc per phase.
- `c-vertical` — families render as a vertical stack, Opus first, each collapsible,
  collapse persisted.
- `c-renderonly` — `effectiveDefaults` and the saved profile are untouched by view
  state.
- `c-twotier` — model rows are collapsed by default and expand to alias/default/move.
- `c-a11y` — both toggle levels expose `aria-expanded`; the move control stays
  keyboard reachable.
- `c-grok-api` — selection persists through the management API and filters the fence.
- `c-grok-guard` — no new web-reachable writer touches `~/.grok/config.toml`.
- `c-grok-switch` — the Grok page shows per-model switches with save/re-apply feedback.
- `c-i18n` — every new string exists in all six locales; `lint:i18n` clean.
- `c-gates` — typecheck, tests (root + gui), lint:gui, lint:i18n, privacy:scan green.
- `c-render` — both pages run and observed in a headless browser after the change.
