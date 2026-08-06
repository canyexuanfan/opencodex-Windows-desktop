# 110 — Phase 12: Cursor structured-edit conversion (#1017, PR #1036)

Credit: **NexusCore** (`@ZachDreamZ`), PR #1036. Reporter: **Vincent-HD**
(#1017). Adoption: **adapted** — provenance derivation corrected.

## Defect

Codex advertises `apply_patch` as a single-string function
(`src/responses/parser.ts:166`). The Cursor adapter emits calls with normalized
arguments but never converts structured edits into a valid `apply_patch`
envelope (`src/adapters/cursor/protobuf-events.ts:388`), so Cursor consistently
produces invalid payloads.

## Why adapted

#1036's translator and tests are good. The remaining defect is provenance:
`src/adapters/cursor/live-transport.ts:543-560` computes visibility from
`cursorVisibleTools` but then derives structured-edit availability and tool
names from the *earlier* `request.tools`. After filtering or budgeting removes a
tool, the two disagree — and a synthetic edit identified by wire name alone can
collide with a real client tool.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/adapters/cursor/live-transport.ts` | MODIFY | `:543-560` — derive the structured-edit set from the final filtered/budgeted catalog produced around `src/adapters/cursor/request-builder.ts:262-277`, not from pre-filter `request.tools` |
| `src/adapters/cursor/protobuf-events.ts` | MODIFY | Convert exact-match replacements into a valid Codex freeform patch envelope before emitting (~`:405`); emit as `apply_patch` preserving the original call id; reject malformed/ambiguous replacements with an explicit bridge error rather than forwarding invalid patch text |
| `src/adapters/cursor/*` | MODIFY | Tag injected tools with internal provenance; never identify a synthetic edit by wire name alone |
| `tests/cursor-structured-edit.test.ts` | NEW/MODIFY | Conversion correctness, name-collision, and post-filter provenance cases |

Injection happens **only** when Codex exposed `apply_patch` — the adapter must
not invent an editing capability the client never offered.

## Verification

- `bun test tests/cursor-structured-edit.test.ts` and the Cursor adapter suites
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 11, base = stack 10 head. `Closes #1017`. Credits NexusCore and Vincent-HD.
