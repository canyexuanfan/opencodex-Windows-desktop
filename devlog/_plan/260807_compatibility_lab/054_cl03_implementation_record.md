# CL-03 implementation record

## Branch

- `feat/cl-03-live-route-probes`
- Starting SHA: `4f746d13799888ea0a8c7a111aa2ad61c2126ea0` (upstream `dev` / #1348 merge)

## Scope delivered

1. Live manifest authority (`023_live_v1_manifest_authority.md`, `024_live_v1_cases.json`, runtime copy)
2. Route subject builder (`src/lab/subject/`)
3. Live sandbox (`src/lab/live/`)
4. Persistence seam (`src/lab/observe/from-live.ts`)
5. Projection applicability (`routeSubjectApplicableToRequirements`)
6. Tests (`tests/lab-live-sandbox.test.ts`, `tests/lab-live-probe.test.ts`)

## Explicitly not started

- CL-04 CLI/API

## Frozen live scenarios (10)

- `responses-core.live.basic-turn`
- `chat-core.live.basic-turn`
- `anthropic-core.live.basic-turn`
- `tools-core.live.function-round-trip`
- `tools-core.live.custom-freeform-round-trip`
- `codex-core.live.tool-turn`
- `codex-core.live.custom-tool-turn`
- `vision-core.live.synthetic-ocr`
- `reasoning-core.live.replay`
- `mcp-core.live.synthetic-tool`

## Acceptance status

Implementation only — not accepted.
