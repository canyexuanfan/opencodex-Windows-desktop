# 40 — Phase 4: Usage privacy minimization

Purpose: ensure persistent usage accounting and debug summaries stay numeric and
coarse, without prompts, tool inputs, profile ARNs, raw upstream bodies, or
credential-derived identifiers.

Planned surfaces:

- `src/usage-log.ts`
- `src/usage-summary.ts`
- `src/usage-debug.ts`
- `tests/usage-log.test.ts`
- `tests/usage-summary.test.ts`
- `tests/usage-debug.test.ts`

Verification:

- Usage records use mode `0o600`.
- Stored records contain provider/model/status/counts but not prompt/tool text.
- Debug body samples are redacted and size-capped.
- Typecheck.
