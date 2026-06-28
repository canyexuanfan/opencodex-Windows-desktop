# 10 — Phase 1: Secret redaction foundation

Purpose: introduce or consolidate a shared redaction policy that can be reused by
request logs, crash diagnostics, usage debug records, OAuth/import diagnostics,
and server error surfaces.

Planned surfaces:

- `src/redact.ts` or existing nearest owner if one already exists.
- Tests proving redaction of:
  - `Authorization: Bearer ...`
  - `apiKey`, `accessToken`, `refreshToken`
  - cookies and `Set-Cookie`
  - Kiro `profileArn`
  - bearer-like strings embedded in nested objects and strings

Non-goals:

- Do not change Kiro adapter parity behavior.
- Do not change provider routing.

Verification:

- Focused redaction unit tests.
- Typecheck.
