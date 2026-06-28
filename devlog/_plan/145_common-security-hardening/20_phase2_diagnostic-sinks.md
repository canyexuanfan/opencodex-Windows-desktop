# 20 — Phase 2: Diagnostic sink redaction

Purpose: route existing crash-guard, request-log, and usage-debug diagnostic
sinks through the shared redactor before any data is stored or returned through
the GUI/API.

Planned surfaces:

- `src/crash-guard.ts`
- `src/server.ts` request log helpers
- `src/usage-debug.ts`
- Existing tests near `tests/crash-guard.test.ts`, `tests/request-log.test.ts`,
  and `tests/usage-debug.test.ts`

Verification:

- Tests assert marker secrets never appear in diagnostic output.
- Existing request-log filtering still works.
- Typecheck.
