# CL-05 implementation record — Compatibility Matrix UI

## Programme position

- **Phase:** CL-05 (read-only GUI)
- **Starting `upstream/dev` SHA:** `d517161aeaa3a974ad3c0360ff0c97b03b4c4520` (merge #1378 / CL-04)
- **Branch:** `feat/cl-05-compatibility-matrix-ui`
- **PR:** DRAFT PENDING → `lidge-jun/opencodex:dev`
- **CL-06:** not started

## Scope delivered

### GUI (`gui/src/pages/`)

- New sidebar route `#lab` — **Compatibility Lab**
- `CompatibilityMatrix.tsx` — read-only verdict matrix over CL-04 management APIs
- `compatibility-matrix-api.ts` — paginated fetch helpers for `/api/lab/status`, `/api/lab/verdicts`, `/api/lab/subjects`
- `compatibility-matrix-shared.ts` — DTO parsing, matrix grouping, filters
- `styles-compatibility-matrix.css` — scrollable matrix + detail tables (api-auth-matrix pattern)
- i18n keys in all seven locales (`en`, `de`, `ko`, `zh`, `ru`, `ja`, `tr`)
- Component/layout tests under `gui/tests/compatibility-matrix*.test.*`

### Behaviour

- Projection status cards (subjects, verdicts, observations, events, built-at)
- Subject × evidence-layer matrix with per-suite verdict badges
- Filterable verdict detail table (layer, verdict, subject id)
- Empty/unavailable/incompatible projection states via existing data-surface contract
- No probe execution, projection rebuild, or evidence mutation

## Validation (local)

- `bun x tsc --noEmit` — pending
- `bun test tests/lab-read-surfaces.test.ts` — pending
- `cd gui && bun test tests/compatibility-matrix.test.tsx tests/compatibility-matrix-layout.test.ts` — pending
- `cd gui && bun run lint` — pending
- `cd gui && bun run build` — pending
- `bun run privacy:scan` — pending

## Acceptance blockers

- Draft PR requires cross-platform CI green
- GUI screenshot in PR body (or `gui-screenshot-waived` label)
- Independent acceptance review not performed

## Out of scope (confirmed)

- CL-06 routing profile compatibility fields, CL-07 fabric, CL-08 shadow/automatic/public publish
- New management APIs or CLI changes (CL-04 read surfaces are sufficient)
- Probe execution, projection rebuild triggers, raw artifact download in GUI
