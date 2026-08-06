# 140 — Phase 15: effort-picker fail-closed + Pi loopback export (PRs #1092, #1085)

Credit: **Eachann** (`关俊江 <email from PR head>`, PR #1092) and **n3wr1ch**
(`n3wr1ch <email from PR head>`, PR #1085).
Adoption: **adapted** — the two bug cores are extracted from two large PRs.

Both slices are small, independent, and touch different files, so they share one
stack phase rather than splitting into two near-empty PRs. If review prefers
them separate, the phase splits cleanly at the file boundary.

## Defect A — effort picker (Eachann, #1092)

A model whose capability ladder is unknown disappears from the effort picker
entirely, instead of being offered with no forced default.

| Path | Op | Content |
|------|----|---------|
| `gui/src/combo-workspace-data.ts` | MODIFY | `:12` — treat an unknown ladder as a wildcard **for picker availability only** |
| `src/combos/request.ts` | KEEP | `:26` continues to omit the runtime default when support is unknown — the runtime stays fail-closed |
| `gui/src/**` tests | MODIFY | Unknown-ladder model appears in the picker; no default is sent at runtime |

**Dropped from #1092:** catalog fallback synthesis, public-name copy redesign,
`imageInput` policy, and locale churn. The PR also fails `git diff --check` on
an added EOF blank line, which the extraction avoids.

## Defect B — Pi loopback export (n3wr1ch, #1085)

Pi's exported client config references an unresolved environment variable, so
loopback models vanish for a user with no API key set.

| Path | Op | Content |
|------|----|---------|
| `src/clients/config-export.ts` | MODIFY | `:704` — use the existing non-secret loopback placeholder instead of the unresolved env reference; `:948` — Pi metadata declares no required environment variable |
| `tests/*config-export*.test.ts` | MODIFY | Serializer output for Pi with no key set |

**Dropped from #1085:** combo/direct-mode filtering, cross-client contract
changes, and generalized export-policy churn across 31 files.

## Verification

- `bun test` on the combo/config-export suites
- `bun run typecheck`
- `bun run lint:gui` and `bun run build:gui` (this phase touches `gui/`)
- `bun run privacy:scan`
- GUI screenshot required in the PR description by repository policy

## PR

Stack 14, base = stack 13 head. Credits Eachann and n3wr1ch, and lists what was
intentionally left in their original PRs.
