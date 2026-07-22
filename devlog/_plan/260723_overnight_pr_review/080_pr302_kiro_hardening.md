# 080 — PR #302: feat(kiro): harden completion and transport integration

- **Author:** mushikingh
- **Branch:** feat/kiro-integration-hardening → dev
- **CI:** enforce-target pass, missing full CI run
- **Decision:** MERGE (last, highest risk)
- **Risk:** High (8 commits, touches core bridge.ts, types.ts, responses.ts, state.ts, parser.ts, schema.ts)

## Changes (8 commits)

1. Provider-aware terminal state: `OcxProviderContinuationState` type.
2. `OcxMessagePhase` type for phase-aware text deltas.
3. `incomplete` event type in bridge SSE handling.
4. `adapterFailureFromEvent()` for structured error extraction.
5. `endTurn` field in response snapshots.
6. `retryable` flag on error/incomplete responses.
7. Non-streaming (`buildResponseJSON`) gets same phase/incomplete support.
8. Tests: bridge.test.ts (+87 lines), responses-parser.test.ts (+15), responses-state.test.ts (+43).

## Files Modified

- `src/bridge.ts` — major: incomplete event, phase-aware messages, structured errors
- `src/responses/parser.ts`, `schema.ts`, `state.ts` — minor extensions
- `src/server/responses.ts` — non-streaming JSON builder updates
- `src/types.ts` — new types (OcxMessagePhase, OcxProviderContinuationState)
- Tests: 3 test files updated

## Review Notes

- Well-structured incremental commits.
- Backwards compatible: new fields are optional, `incomplete` is additive.
- Merge LAST to minimize conflict surface with #283 and #286 which also touch responses.ts.
