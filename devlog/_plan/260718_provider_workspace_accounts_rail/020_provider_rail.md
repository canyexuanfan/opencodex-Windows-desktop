# Work phase 020 — provider rail hierarchy and responsiveness

## Outcome

Replace the rail's horizontal fragment pile with a compact two-line semantic row, remove duplicated page controls, and make split-pane/detail composition adapt before text becomes clipped or vertically stacked.

## Scope boundary

### IN

- `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`
- `gui/src/components/provider-workspace/ProviderRail.tsx`
- `gui/src/styles/provider-workspace-shell.css`
- `gui/src/i18n/{en,ko,de,zh}.ts` only if new accessible copy is unavoidable
- `tests/provider-workspace-rail.test.ts` (new pure/source contract)
- `docs/design-system/components.md` during C after behavior is proven

### OUT

- Provider logo replacement, catalog grouping logic, filter feature redesign, overview quota cards, global sidebar redesign, or arbitrary new breakpoints not grounded in the app shell.

## Exact diff plan

### MODIFY `ProviderWorkspaceShell.tsx`

- Delete the rail-local title and Add button because the page header already owns those actions.
- Keep search and filter as the first rail controls.
- Change rail group descriptors from preformatted `Label (count)` strings to `{ id, label, count, items }` and render label/count as separate spans.
- Fix listbox focus ownership: the listbox itself is not an extra Tab stop when option buttons own focus; retain ArrowUp/Down/Home/End behavior on bubbled option events.
- Pass unchanged provider data to `RailRow`; do not move auth/account state into the shell.

### MODIFY `ProviderRail.tsx`

- Replace independent name/badge/model-count/trail siblings with icon + copy + trail.
- Primary copy: display name and only necessary Free/Local exception badge.
- Secondary copy: model count and duplicate config id only when disambiguation is required. Readiness text remains in the group heading and localized button name/title; the fixed dot stays empty and `aria-hidden`.
- Keep default star with accessible label; remove or responsively hide chevron on persistent desktop split navigation.
- Preserve `providerIconSrc` and its original `<img>` path; do not recolor source SVGs or replace them with workspace-tinted masks.
- Keep full label in title/accessible name; never allow `word-break` or vertical glyph stacking.

### MODIFY `provider-workspace-shell.css`

- Consolidate duplicate `.providers-workspace-rail-row` declarations into one tokenized grid/flex definition.
- Use existing `--space-*`, `--text-*`, `--radius-*`, `--text`, `--muted`, `--green`, `--amber`, and `--border`; replace undefined `--fg`/`--fg-muted` usages in the touched workspace surface.
- Set row minimum geometry, `min-width:0`, ellipsis, `white-space:nowrap`, and stable hover/focus/selected fills.
- Make group headings sentence case with separate tabular count.
- Add a shell-local container wrapper/query and collapse the split below approximately 640px of available workspace width, derived from a 280px rail + gap + usable 320px detail. Keep the existing viewport rule as fallback.
- At constrained desktop widths, reduce rail width and collapse `.pws-overview-layout` to one column before the key/value detail wraps badly.
- At the existing mobile boundary, stack rail/detail, bound the rail list height, and keep 44px touch targets. Do not add scroll-driven motion.
- Ensure the workspace root and children cannot create horizontal document overflow.

### NEW `tests/provider-workspace-rail.test.ts`

- Verify status label/class mappings and the semantic source contract for primary/secondary copy.
- Assert the shell no longer renders the duplicate rail Add action or listbox `tabIndex=0`.
- Assert CSS contains no `var(--fg` references and the row copy has explicit no-wrap/ellipsis contracts.
- These source assertions are a narrow regression net; screenshots remain the layout oracle.

### C-phase SoT sync

- Update `docs/design-system/components.md` with provider rail two-line grammar, tab semantics, account-row state rules, and the no-raw-ID requirement after the rendered implementation passes.

## Activation matrix

| Case | Trigger | Observable evidence |
|---|---|---|
| previous collision | long provider + count + default/free state | no overlap; name ellipsizes; metadata remains readable |
| duplicate name | two display labels collide | safe config-id disambiguation without raw fragment dominance |
| status | ready/setup/disabled | localized group heading + accessible name/title, with empty reinforcing dot |
| empty model count | undefined/zero | no orphan separator or floating dot |
| constrained desktop | effective CSS width around 1024/768 | rail contracts and detail becomes one column before clipping |
| mobile | effective CSS width 390/320 | stacked composition, bounded rail, 44px controls |
| Korean/English | locale switch with longest labels | no character stacking or clipped control labels |
| themes | light/dark | active/focus states use defined tokens and remain visible |
| keyboard | Tab then ArrowUp/Down/Home/End | one coherent option focus model, no listbox double stop |

## Verification

```sh
bun test --isolate tests/provider-workspace-rail.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
bun run typecheck
cd gui && bun run lint:i18n
cd gui && bun run build
rg -n 'var\(--fg|font-size:\s*[0-9]|font-weight:\s*[0-9]' gui/src/styles/provider-workspace-shell.css
```

Browser screenshots and observed DOM metrics are required at desktop, split, tablet, mobile, and narrow widths in English and Korean. Stop after one clean observation per changed state/width; rerender only after a repair.
