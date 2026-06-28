# 50 — Phase 5: Credential import safeguards

Purpose: make credential import behavior auditable and safe across OAuth-backed
providers without altering Kiro parity semantics.

Planned surfaces:

- `src/oauth/store.ts`
- `src/oauth/index.ts`
- `src/oauth/kiro.ts` only for common import metadata and diagnostics, not
  gateway parity behavior.
- Existing OAuth tests.

Checks:

- Imported credentials have clear source metadata where the config shape permits.
- Diagnostics distinguish "unreadable", "schema mismatch", and "no token"
  without printing token values.
- Refresh tokens are never returned through status/config APIs.

Verification:

- Focused OAuth privacy/import tests.
- Typecheck.
