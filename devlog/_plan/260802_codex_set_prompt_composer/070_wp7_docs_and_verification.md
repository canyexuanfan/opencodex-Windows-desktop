# 070 — WP7: docs, locales, and the closing gate

## Docs

New page: `docs-site/src/content/docs/guides/codex-prompt.md`, plus the five
locale copies (`ja`, `ko`, `ru`, `zh-cn`) the site already carries.

Contents:

1. What the prompt stack is — the layer table from `001` §1, in user terms.
2. Which layers can be turned off, and which cannot **and why**. `001` §4 is
   the honest answer: Codex has no off-switch for them, so neither do we.
3. Custom layers: what they are, where they land (`developer_instructions`),
   what happens to text the user wrote by hand (preserved, never edited).
4. Presets: adaptations, not copies, with the reasoning from `002` §5.
5. Timing: new sessions, not running ones (`003` §3).
6. When a managed layer overrides a setting (`003` §6).

Also update:

- `docs-site/src/content/docs/reference/configuration/` — the five toggle keys
  and `developer_instructions`, in the file where root keys already live.
- Any nav/sidebar entry naming "Codex Auth".

Astro's config lists locales explicitly; a page added to English only shows a
missing-translation state. Either all six, or an explicit decision — and the
`260802_docs_overhaul` unit already established all six as the standard.

## Locale parity

`typecheck` catches missing GUI keys because every dictionary is
`Record<TKey, string>` (`004` §D). It does **not** catch a key that exists but
still holds English text. WP7 reads every `codexSet.*` string in all six
locales and confirms it is actually translated.

Korean copy follows the house rule: no translationese, no AI idioms, one
register throughout.

## Full gate

On the exact HEAD that closes the unit:

```bash
bun run typecheck
bun run test
bun run lint:gui
bun run privacy:scan
bun run build:gui
git diff --check
```

All six must pass. `build:gui` is included because this unit adds a stylesheet
and new components — a Vite build failure would not surface in typecheck.

## Acceptance — one row per ask item

| # | Ask | Proven by |
|---|---|---|
| 1 | tab renamed Codex Set | `030` tests 1-3 |
| 2 | current window → Multi-auth | `030` test 1 |
| 3 | Prompt section beside it | `030` test 2 |
| 4 | Logs-style left/right panels | `030` tests 4-6 |
| 5 | built-in layers switchable | `040` test 4 |
| 6 | `+` adds custom layers | `050` tests 1-2 |
| 7 | built-in rows never deletable | `050` test 12 |
| 8 | custom rows: dialog, save, toggle, delete | `050` tests 1-5 |
| 9 | built-in dialog is read-only | `040` test 7 |
| 10 | **non-disableable layers cannot be turned off** | `040` test 2 **and** `020` test 5 |
| 11 | presets provided, Codex-compatible | `060` tests 4, 7-10 |
| 12 | Theme deferred with steps recorded | `090` exists, nothing implemented |

Item 10 carries two proofs on purpose. A UI-only guarantee is a UI that looks
safe; an API-only guarantee is a boundary nobody exercises.

## Residual risk, stated rather than hidden

1. **Upstream drift.** Every key here is ≤ 4 months old and `001` §6 shows the
   surface still moving. A rename upstream makes a toggle silently ineffective.
   Mitigation: absent key reads as unknown, never as false. Not a fix.
2. **Model compliance is unproven.** `002` needs-verification: static ordering
   is proven; whether a model obeys a custom layer that contradicts its base
   prompt is not. The linter warns, it does not guarantee.
3. **Managed-layer override detection is partial.** `003` §6 — we report what we
   can read. An MDM layer we cannot see still wins.
4. **Extension layers are not enumerable.** `001` needs-verification. The UI
   says "layers opencodex knows about", not "all layers".
5. **Shared key ownership.** `003` §4 — Codex may rewrite
   `developer_instructions` itself. Our fences should survive `toml_edit`, but
   that is inference from `edit_tests.rs:600-655`, not a test we own.

None of these blocks the unit. All belong in the close-out, and 1 and 5 deserve
a live re-check whenever opencodex bumps its supported Codex version.
