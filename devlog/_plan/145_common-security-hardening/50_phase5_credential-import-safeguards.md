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

## Diff-level plan

MODIFY `src/oauth/types.ts`

- Add a small `OAuthCredentialSource` union:
  `oauth | local-cli | environment | manual`.
- Add optional `source` metadata to persisted OAuth credentials.

MODIFY `src/oauth/store.ts`

- Normalize credentials before writing `auth.json`.
- Persist only `access`, `refresh`, `expires`, optional masked-status metadata
  (`email`, `accountId`, `source`), and drop any accidental extra fields such
  as prompt text, headers, ID tokens, or diagnostics.

MODIFY `src/oauth/index.ts`

- Default ordinary OAuth logins to source `oauth`.
- Preserve Kiro refreshed/imported credentials as `local-cli`.
- Expose only safe `source` metadata through `getLoginStatus()`, never access
  or refresh token values.

MODIFY `src/oauth/kiro.ts`

- Add `inspectKiroCliSqlite()` for token-import diagnostics with sanitized
  location labels and status codes only.
- Keep `readKiroCliSqlite()` as the compatibility wrapper used by existing code.
- Mark Kiro credentials by source: `local-cli`, `environment`, or `manual`.

MODIFY tests

- `tests/oauth-status-privacy.test.ts`: status source is safe and credential
  persistence allowlists known fields only.
- `tests/kiro-oauth.test.ts`: Kiro credential sources and sanitized SQLite
  import diagnostics.

Out of scope:

- Do not change Kiro request/refresh semantics beyond metadata and diagnostics.
- Do not remove refresh-token persistence yet; that requires a product decision
  about memory-only imports or OS keychain storage.

## Build record

Files changed:

- MODIFY `src/oauth/types.ts`: added `OAuthCredentialSource` and optional
  credential `source`.
- MODIFY `src/oauth/store.ts`: credential persistence now allowlists known
  fields before writing `auth.json`.
- MODIFY `src/oauth/index.ts`: `runLogin()` defaults to `oauth` source,
  refreshed Kiro CLI credentials preserve `local-cli`, and `getLoginStatus()`
  exposes only safe source metadata.
- MODIFY `src/oauth/kiro.ts`: added sanitized SQLite import diagnostics and
  source metadata for Kiro CLI/env/manual imports.
- MODIFY `tests/oauth-status-privacy.test.ts`: added status-source and
  credential allowlist privacy regression coverage.
- MODIFY `tests/kiro-oauth.test.ts`: added source metadata and diagnostic
  no-secret/no-path leak coverage.
- MODIFY `devlog/_plan/145_common-security-hardening/50_phase5_credential-import-safeguards.md`:
  this build/verification record.

Verification:

- `bun test tests/oauth-status-privacy.test.ts tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts`
  -> 22 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.

## Independent verification follow-up

Read-only sub-agent audit (`Gauss`) returned FAIL after commit `68b079f`.

Findings:

- Existing providers in `auth.json` were not re-normalized when saving one
  provider, so legacy extra fields could survive rewrites.
- xAI/Anthropic local-token imports could be labeled as `oauth`.
- Refreshed credentials could lose existing `source` metadata.
- Legacy arbitrary `source` strings could be reflected by `getLoginStatus()`.
- Kiro diagnostics needed coverage for `unreadable`, `token_missing`, and
  `invalid_json`.

Follow-up changes:

- MODIFY `src/oauth/store.ts`: `loadAuthStore()` now normalizes the whole store;
  invalid credential sources and extra fields are dropped for all providers.
- MODIFY `src/oauth/index.ts`: refresh persistence preserves existing source
  metadata when refresh responses do not provide one.
- MODIFY `src/oauth/local-token-detect.ts`: Grok CLI and Claude Code imports are
  tagged `local-cli` at detection time.
- MODIFY `src/oauth/xai.ts` and `src/oauth/anthropic.ts`: refreshed local imports
  keep `local-cli`.
- MODIFY tests: added legacy-store whole-store normalization, invalid source
  reflection, refresh source preservation, and missing Kiro diagnostic cases.

Re-verification:

- `bun test tests/oauth-status-privacy.test.ts tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts`
  -> 26 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
