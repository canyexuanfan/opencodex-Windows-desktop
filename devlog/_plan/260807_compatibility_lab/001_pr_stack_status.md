- **Scope:** bounded live-route probes for `live_route_compatibility`; live manifest
  authority; `RouteSubjectV1` builder; `LabDestinationV1` / credential lease sandbox;
  inert tool/MCP stubs; live runner/executor; `observe/from-live` persistence;
  projection applicability for route subjects.
- **Explicitly out of scope:** CL-04 CLI/API, CL-05 UI, CL-06 profile fields, Fabric,
  shadow/automatic probing, production request-path probes.

### CL-03 validation (local, 2026-08-09)

- `bun x tsc --noEmit`: passed
- `bun test tests/lab-conformance-harness.test.ts`: 17/17 passed
- `bun test tests/lab-evidence-ledger.test.ts`: 37/41 passed (4 Windows SQLite `EPERM`
  flakes in `wipeSqlite`; `rebuild.ts` unchanged vs `upstream/dev` — pre-existing)
- `bun test tests/lab-live-probe.test.ts`: 19/19 passed
- `bun test tests/lab-live-sandbox.test.ts`: 17/17 passed
- `bun run privacy:scan`: passed
- Cross-platform CI on #1352: pending at open time

### CL-03 blockers

- Independent acceptance review not performed
- Draft PR review findings not yet reconciled
- Full local ledger suite not green on Windows host (pre-existing SQLite EPERM)