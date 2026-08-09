# CL-05 implementation record - Compatibility Matrix UI

## Programme position

- **Phase:** CL-05 (read-only GUI)
- **Starting `upstream/dev` SHA:** `d517161aeaa3a974ad3c0360ff0c97b03b4c4520` (merge #1378 / CL-04)
- **Branch:** `feat/cl-05-compatibility-matrix-ui`
- **PR:** DRAFT → `lidge-jun/opencodex:dev` ([#1384](https://github.com/lidge-jun/opencodex/pull/1384))
- **CL-06:** not started

## Scope delivered

### GUI (`gui/src/pages/`)

- **Models → Compatibility tab** at `#models/compatibility` (not a standalone sidebar page)
- Legacy `#lab` hash redirects to `#models/compatibility`
- `CompatibilityMatrix.tsx` - read-only verdict matrix over CL-04 management APIs
- `compatibility-matrix-api.ts` - paginated fetch helpers for `/api/lab/status`, `/api/lab/verdicts`, `/api/lab/subjects`, detail reads
- `compatibility-matrix-shared.ts` - DTO parsing, matrix grouping, filters
- `styles-compatibility-matrix.css` - scrollable matrix + detail pane
- i18n keys in all seven locales (`en`, `de`, `ko`, `zh`, `ru`, `ja`, `tr`)
- Component/layout tests under `gui/tests/compatibility-lab.test.tsx`

### Behaviour

- Projection status cards (subjects, verdicts, observations, events, built-at)
- Subject × evidence-layer matrix with per-suite verdict badges
- Server-side verdict filters (layer, verdict, subjectId, suiteId) with paginated "Load more"
- Verdict detail pane (subject, observations, contributing events, artifact metadata only)
- Empty/unavailable/incompatible projection states via existing data-surface contract
- Lazy mount with `active` / `pauseWhenHidden` gating inside Models workspace
- No probe execution, projection rebuild, or evidence mutation

## Validation (local)

- `bun x tsc --noEmit` - passed
- `bun test tests/lab-read-surfaces.test.ts tests/models-workspace-tabs.test.ts` - 33/33 passed
- `cd gui && bun test tests/compatibility-lab.test.tsx tests/models-workspace-panels.test.tsx` - 29/29 passed
- `bun run lint:gui && bun run doctor:gui && bun run build:gui && bun run privacy:scan` - passed

## Acceptance blockers

- Draft PR requires cross-platform CI green
- GUI screenshot in PR body (or `gui-screenshot-waived` label)
- Independent acceptance review not performed

## Out of scope (confirmed)

- CL-06 routing profile compatibility fields, CL-07 fabric, CL-08 shadow/automatic/public publish
- New management APIs or CLI changes (CL-04 read surfaces are sufficient)
- Probe execution, projection rebuild triggers, raw artifact download in GUI
