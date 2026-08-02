# 050 — WP5: custom layers

The `+` button, the editable dialog, delete, reorder. This is ask items 5, 6,
7 and the half of item 4 that applies to user-authored rows.

## Files

```
gui/src/components/codex-set/CustomLayerRow.tsx      (new)
gui/src/components/codex-set/CustomLayerDialog.tsx   (new)
gui/src/components/codex-set/custom-layer-state.ts   (new — reducer)
```

## Where the text goes

`developer_instructions`, composed by WP1. **Not** `model_instructions_file` —
`002` §3 proves that key replaces the entire base prompt, so wiring `+` to it
would delete Codex's own instructions on first save. `000` records this as the
deliberate deviation from the literal ask.

WP1 also settled where a *disabled* body lives: `.opencodex-prompt-layers.json`
beside config.toml holds every layer including disabled bodies, while
`developer_instructions` holds only the enabled subset. Anything else would
inject text the user just switched off.

## Row

```
  My house rules              [ ●─ ] on    [edit] [×]
```

Switch, edit, delete — all three, unlike built-ins which never get delete
(ask item 6). Drag handle for reorder; order is composition order.

## Dialog — editable

Ask item 7. Title input, body textarea, live compatibility warnings, Save,
Cancel. Same dialog scaffolding as WP4's read-only one; the difference is the
editor and the Save action, not a separate component family.

Escape cancels, discards, returns focus. When the body is dirty, Escape asks
first — a textarea the user has typed into is not the same as a read-only
dialog they glanced at.

## The `+` flow

```
[ + Add layer ]
  ├── Blank
  └── From preset ▸   (WP6 fills this; WP5 ships Blank only)
```

WP5 ends with a working Blank path and the preset submenu present but empty.
WP6 populates it. Splitting here keeps the phases independent: presets need the
linter, and the linter needs a dialog to render into.

## Client-side validation

Mirrors `020`'s server rules so the user sees the problem while typing rather
than on Save:

| Rule | Message |
|---|---|
| empty title | "제목을 입력하세요" |
| title > 80 chars | count shown, Save disabled |
| body > 64 KiB | size shown, Save disabled |
| composed total > 128 KiB | which layers overflow |
| > 32 layers | `+` disabled with the reason |

The server still enforces every one of these (`020`). Client validation is
courtesy; the API is the boundary.

## Compatibility warnings

The `002` §6 checks run live in the editor, **as warnings, not blocks**. A user
who deliberately wants to override Codex's identity may; they just should not
do it by accident. WP6 owns the linter implementation; WP5 renders whatever it
returns.

## Reorder

Order is composition order in `developer_instructions`. Reordering PUTs the
full list — `020`'s custom endpoint is full-replacement precisely so ordering
needs no separate verb.

Keyboard reorder must work: up/down buttons alongside the drag handle. A
drag-only affordance is not reachable.

## Delete

Confirms first, because a body can be long and there is no undo. Delete removes
the row from the list and PUTs the remainder; WP1 then drops its fence from
config.toml and its entry from the JSON file.

## Tests — `gui/tests/codex-set-custom-layers.test.tsx`

1. `+ Blank` opens an empty editor
2. Save PUTs the full list with the new layer appended
3. edit changes title and body, id is unchanged
4. toggling a custom layer PUTs with `enabled` flipped
5. delete confirms, then PUTs without the row
6. reorder PUTs the new order
7. keyboard reorder works without pointer events
8. dirty Escape asks before discarding
9. clean Escape closes immediately, focus returns
10. each validation rule disables Save with its message
11. a rejected PUT restores the previous list
12. built-in rows still have no delete control

Case 12 re-asserts ask item 6 from the custom-layer side: adding delete to one
row family must not leak it into the other.
