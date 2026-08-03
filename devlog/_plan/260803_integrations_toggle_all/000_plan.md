# Turning the other four integrations on and off

## Objective

Codex, Claude Code, Claude Desktop and Grok Build become switchable from the
Integrations overview, each write snapshot-backed and each removal explained
before it happens. All four stay ON by default while opencodex runs.

> **Status: replanned.** Three audit rounds failed the byte-snapshot substrate
> (`003`, `004`, `005`). `006_replan_semantic_restore.md` inverts the primitive
> to per-client semantic restore and splits the four clients into separate
> phases. The phase map below is superseded by `006`; `010` and `020` are
> retired under `_retired/`. Implementation has not started — this unit is still
> a docs-only Phase-0 cycle.

Research: `001_removal_path_inventory.md`. Dialog direction and copy:
`002_consequence_dialog_ux.md`. Audit fold-backs: `003`, `004`, `005`. Current
direction: `006`. Read `001`, `002`, `005` and `006` before any phase work.

## What the research and the audits changed about the shape

1. **The four clients do not share a mechanism.** The first three revisions put
   them all on one byte-snapshot substrate; three audit rounds took it apart.
   Undo is now a per-client STATE that gets re-applied through the same path
   that established it, and byte snapshots survive only where a file genuinely
   is the whole integration — Grok's `config.toml` and Desktop's library
   (`006`).
2. **Claude Desktop has no ownership record and no removal path.** Apply
   overwrites `appliedId` without recording what was there, and identifies its
   own row by a display name any user could also choose. Removal needs both
   gaps closed: the library bytes restore the previous selection, and a
   persisted `appliedProfileId` plus a payload marker proves which row is ours
   (`014`).
3. **`desktopAutoApply` would undo the disable.** It defaults ON whenever a
   stored `desktopProfile` exists, so the subagent-model route recreates the
   file. Disable is not complete without neutralizing it.
4. **Restoring a whole config file is not undo.** opencodex's `config.json`
   holds every other setting, so a byte restore would revert provider and
   account changes made after the disable. The four Desktop bookkeeping fields
   go back individually through `saveConfigPreservingClaudeCode`, which merges
   the `claudeCode` subtree rather than replacing the file.

## Dependency order

substrate → Desktop remover → routes → GUI dialog and cards.

The substrate is first because every later phase writes through it. Desktop is
second: it is the only removal built from nothing and the only one that can
corrupt another application's state. Routes are third because they expose what
the first two produce, including the coordinator both route families share.
The GUI is last because its copy must name what the writers actually do — a
dialog written before the writer promises whatever sounded reasonable, which is
how rev 1 came to promise a restore it could not perform.

Phase map: see `006` §The four are not alike. Six phases — Claude Code, Grok,
Codex, Desktop, routes, GUI — because three audits established the four clients
do not share one mechanism. Each closes with something independently verifiable;
Claude Code and Grok are independently shippable ahead of the two hard ones.

## Scope boundary

IN: `src/integrations/` (widening only), a new `src/integrations/native/`,
`src/claude/desktop-3p.ts` (adding a remover), `src/server/management/`,
`gui/src/pages/integrations/`, `gui/src/i18n/*.ts`, `gui/src/styles-integrations.css`,
`tests/`, `gui/tests/`.

OUT: the six file clients' writer/merge/serialize semantics — reused, never
modified. The release pipeline. `docs-site`. Any push. Any change to `/v1`
routing beyond what enable/disable implies.

## Criteria

- C1 — all four toggle both directions from the overview cards.
- C2 — every native toggle can be undone: a captured pre-state (Claude Code,
  Codex) or captured bytes (Grok, Desktop's library) re-establish the previous
  arrangement, proven by a per-client round-trip test.
- C2b — an unrelated config edit made between a disable and its undo SURVIVES
  the undo.
- C3 — Desktop disable leaves `_meta.json` internally consistent: no dangling
  `appliedId`, no orphaned `.bak`, markers cleared, auto-apply neutralized; and
  no restore ever produces an `appliedId` naming a missing file.
- C4 — Codex, Desktop and Grok toggle-off are gated by a dialog naming path,
  breakage, undo and side effects; Claude Code is not (UX-LAZY-01, `002`).
- C5 — `orphaned-marker`, home mismatch, and foreign-provider refusals surface as
  localized explained refusals, never a raw 500.
- C6 — all six locales carry every new key.
- C7 — typecheck, full `bun run test`, gui test, gui lint, privacy scan green.
- C8 — a partially-failed operation reports `partial` with residual paths and a
  journal row, never "nothing changed".
- C9 — native and file-client mutations share one coordinator; a concurrent pair
  loses neither a journal row nor an ownership record.

## Risk register

| Risk | Mitigation |
|---|---|
| Desktop removal corrupts `_meta.json` for a real user | Never delete blind: prove ownership by persisted id AND payload marker, repair `appliedId` to a surviving entry whose file exists, refuse when none does (`014`) |
| Codex disable strips something the user owns | Delegate to `restoreNativeCodex`, which is already marker-ownership-aware; do not reimplement stripping (`013`) |
| Restore reconstructs a broken state | Desktop's library restores in dependency order — files before the metadata that references them — so `_meta.json` never names a missing profile (`014`) |
| A half-failed removal reports success or "no change" | `partial` outcome with residual items and a journal row (`011` §NativeApplyResult, `030`) |
| Auto-apply resurrects a disabled Desktop profile | WP2 neutralizes it as part of disable, and a test proves a provider change does not recreate the file |
| Shared teardown runs under a foreign-home service | Ownership preflight before Codex and Grok disable (`012`, `013`) |
| Concurrent mutations lose bookkeeping | One resource-keyed coordinator shared with the file-client routes (`030`) |
| A corrupted snapshot names a write destination | Pre-states hold values, never paths; every path is resolved fresh at apply time (`006`) |
| Undo reverts unrelated settings | Semantic restore of named fields through the merging config writer (`014`) |

## Recorded follow-up, not in scope

`config:ocx` serializes integration-owned config writes only. Roughly nine other
`saveConfigPreservingClaudeCode` callers in `agent-settings-routes.ts` remain
outside the coordinator; racing one of them is pre-existing behavior this unit
neither creates nor fixes. Migrating them is a separate unit.
