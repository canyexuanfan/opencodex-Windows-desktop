# 040 — WP4: built-in layer rows

The Prompt panel gets real content: every built-in layer, its switch or its
lock, and a read-only dialog. Custom layers are WP5.

## Files

```
gui/src/components/codex-set/PromptLayerPanel.tsx    (new)
gui/src/components/codex-set/PromptLayerRow.tsx      (new)
gui/src/components/codex-set/PromptLayerDialog.tsx   (new)
gui/src/components/codex-set/prompt-layer-copy.ts    (new — id → i18n key map)
gui/src/styles-codex-set.css                         (new)
```

Row and dialog are modeled on `ClientConfigRow.tsx` / `ClientConfigDialog.tsx`,
which already solve "compact row, detail behind a dialog" in this codebase
(`004` §Reuse map).

## Data

`useDataSurface("codex-prompt:" + apiBase, [apiBase], loader, { isEmpty })`
(`004` §G). Cold load shows `DataSurfaceSkeleton`; a refresh keeps stale rows
visible rather than blanking the panel. After a successful PUT, publish the
echoed snapshot with `setClientResourceData` — never optimistic local state,
because `003` §6 means the server may report a different effective value than
the one just requested.

No polling. This file changes when the user changes it, or out of band; a 30s
timer would fight the editor for no gain.

## Row kinds

`005` defines four. The distinction is enforced by the server's `locked` list
(`020`), not by a GUI constant:

```tsx
function rowKind(id: string, snapshot: Snapshot): RowKind {
  if (snapshot.locked.includes(id)) return "locked";
  if (snapshot.features.some(f => f.id === id)) return "feature";
  return "toggleable";
}
```

| Kind | Renders |
|---|---|
| `locked` | lock glyph, "always on", **no switch element at all** |
| `feature` | gear glyph, governing key, link to its owner, no switch |
| `toggleable` | a real switch |

"No switch element at all" is literal: no `<input type="checkbox" disabled>`,
no greyed toggle. `005` explains the reasoning — a disabled control claims the
capability exists and is temporarily unavailable, which is false. `001` §4
proves these layers have no off-switch anywhere in Codex.

## Ordering

Assembly order from `001` §1, so the list reads the way the prompt is built.
Skills carries a footnote that its position among extensions is
registration-dependent (`001` ordering caveat).

## Dialog — read-only

Ask item 8: built-in layers open a popup that cannot be edited. Contents:

- what the layer does, in one sentence
- the exact config key and its TOML position
- default, configured, effective
- when configured ≠ effective, the override notice from `003` §6
- rendered text where opencodex can read it; otherwise an honest "not readable
  from here"
- Copy button

No textarea, no Save. Escape closes and returns focus, matching
`client-config-panel.test.tsx:204-222`.

## Failure states

From `005`:

- `configExists: false` → rows at documented defaults, switches disabled with a
  note that the file is created on first change. (Here a disabled switch **is**
  right: the capability exists, the file merely does not yet.)
- `readable: false` → panel refuses writes and says so. `003` §4: Codex cannot
  parse malformed TOML either, so writing would compound the problem.
- PUT rejected → revert the row to the server snapshot and surface the error.
  Never leave the switch showing a state the file does not have.

## Tests — `gui/tests/codex-set-prompt-layers.test.tsx`

Harness from `client-config-panel.test.tsx:86-152`.

1. every snapshot layer renders a row
2. a `locked` id renders **no switch element** — query returns null
3. a `feature` id renders no switch and names its governing key
4. a `toggleable` id renders a working switch
5. toggling PUTs once with the right body
6. a rejected PUT reverts the row
7. dialog opens read-only: no textarea, no Save
8. Escape closes and returns focus
9. `configExists: false` disables switches with the create-on-write note
10. `readable: false` refuses writes
11. configured ≠ effective renders the override notice
12. cold load renders the skeleton; refresh keeps rows visible

Case 2 is ask item 9 at the rendering layer; `020` case 5 is the same guarantee
at the API layer. Both are required — one without the other is a UI that merely
looks safe, or an API nobody exercises.

Also add `CodexSet` to `MIGRATED` in `page-loading-contract.test.tsx:25-39`.

## Styling

Design tokens only, no gradients — the constraint `260802_api_tab_client_connect_simplify`
records at `styles-apikeys-workspace.css:1-10`. Rows reuse existing row/switch
patterns; the new stylesheet only carries what the layer list genuinely needs.
