- `tools-core.live.function-round-trip`
- `tools-core.live.custom-freeform-round-trip`
- `codex-core.live.tool-turn`
- `codex-core.live.custom-tool-turn`
- `vision-core.live.synthetic-ocr`
- `reasoning-core.live.replay`
- `mcp-core.live.synthetic-tool`

## Validation (2026-08-09)

| Check | Result |
|---|---|
| `bun x tsc --noEmit` | pass |
| `tests/lab-conformance-harness.test.ts` | 17/17 |
| `tests/lab-evidence-ledger.test.ts` | 37/41 (4 Windows SQLite EPERM flakes; pre-existing) |
| `tests/lab-live-probe.test.ts` | 19/19 |
| `tests/lab-live-sandbox.test.ts` | 17/17 |
| `bun run privacy:scan` | pass |

## Explicitly not started

- CL-04 Lab CLI or management/read APIs
- CL-05 Compatibility Matrix UI
- CL-06 Routing Profile compatibility policy

## Acceptance status

Implementation only — **not accepted**. CL-04 remains blocked until independent CL-03
acceptance and review reconciliation.