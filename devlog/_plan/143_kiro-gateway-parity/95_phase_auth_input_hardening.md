# Phase 95 (P0 residual) - Kiro auth input hardening without multi-account

## Trigger

The external code review says Phase 90 closed refresh singleflight and
SQLite reload, but not the broader single-account Kiro auth surface:

- JSON credential file import.
- AWS SSO OIDC refresh through `clientId`/`clientSecret`.
- Device registration keys in kiro-cli SQLite.
- API-region/runtime-region split (`KIRO_API_REGION`) without conflating it
  with SSO/auth refresh region (`KIRO_REGION`).
- Broader SQLite path coverage and clearer diagnostics.

User scope decision: account failover / multi-account routing is not needed.
Do not implement account pool, circuit breaker, sticky account selection, or
per-request account failover in this phase.

## Current state

- `src/oauth/index.ts` already has per-provider singleflight refresh.
- `src/oauth/index.ts` already reloads fresh Kiro CLI SQLite tokens before
  calling the refresh endpoint and after refresh failure.
- `src/oauth/kiro.ts` still reads only two hardcoded SQLite paths, ignores
  device-registration keys, has no JSON credential file import, and uses
  `KIRO_REGION` for both auth refresh and runtime API.
- `src/adapters/kiro.ts` calls `resolveKiroRegion()` for the runtime URL.

## Diff plan

### ADD `src/oauth/kiro-credentials.ts`

Add a small parser module so `src/oauth/kiro.ts` stays below the 500-line
limit:

- Export `ImportedKiroCredential`, `KiroAuthType`, and helpers:
  - `readImportedKiroCredential(opts?)`
  - `readKiroCliSqliteCredential()`
  - `inferRegionFromProfileArn(arn)`
- Source precedence:
  1. `KIRO_CREDS_FILE` or `KIRO_CREDENTIALS_FILE` JSON.
  2. `KIRO_CLI_DB_FILE` SQLite override.
  3. Known SQLite paths:
     - `~/Library/Application Support/kiro-cli/data.sqlite3`
     - `~/.local/share/kiro-cli/data.sqlite3`
     - `~/.local/share/amazon-q/data.sqlite3`
     - `~/.kiro/sso/cache.db`
  4. Existing env-token fallback stays in `loginKiro()`.
- JSON fields:
  - `accessToken` / `access_token`
  - `refreshToken` / `refresh_token`
  - `expiresAt` / `expires_at`
  - `profileArn` / `profile_arn`
  - `region`
  - `apiRegion` / `api_region`
  - `clientId` / `client_id`
  - `clientSecret` / `client_secret`
  - `clientIdHash`, loading `~/.aws/sso/cache/{clientIdHash}.json`.
- SQLite fields:
  - Existing token keys: `kirocli:social:token`,
    `kirocli:odic:token`, `codewhisperer:odic:token`.
  - Device-registration keys: `kirocli:odic:device-registration`,
    `codewhisperer:odic:device-registration`.
  - `state` table profile row: `api.codewhisperer.profile`.
- Apply `PRAGMA busy_timeout = 5000` on opened SQLite handles.
- Preserve read-only behavior: this phase only reads external Kiro stores.
- Diagnostics must be secret-free. Return only source labels/status codes such
  as `missing`, `invalid_json`, `token_found`, `registration_found`, and
  `schema_mismatch`; never include token values, refresh tokens, client secrets,
  profile ARNs, raw JSON payloads, or absolute user paths in diagnostic objects,
  progress strings, thrown messages, or tests.

### MODIFY `src/oauth/kiro.ts`

- Replace inline SQLite scanning with the new helper.
- Keep the public `readKiroCliSqlite()` export shape for existing tests.
- Preserve and adapt the public `inspectKiroCliSqlite()` export introduced by
  security commit `68b079f`; it must continue returning
  `{ token, diagnostics }` with token values only in `token`, never in
  diagnostics.
- `loginKiro()` source order becomes imported credential JSON/SQLite ->
  `KIRO_ACCESS_TOKEN` -> manual paste.
- Add `resolveKiroApiRegion()`:
  - `KIRO_API_REGION`
  - imported `apiRegion`
  - imported `profileArn` ARN region
  - imported SSO `region`
  - `KIRO_REGION`
  - `us-east-1`
- Keep `resolveKiroRegion()` as auth/SSO refresh region:
  - imported SSO `region`
  - `KIRO_REGION`
  - `us-east-1`
- Keep `resolveKiroProfileArn()` env-first, then imported credential.
- `refreshKiroToken()` chooses:
  - AWS SSO OIDC endpoint when imported current credential has
    `clientId` + `clientSecret`.
  - Kiro Desktop refresh endpoint otherwise.
- OIDC request:
  - URL `https://oidc.{region}.amazonaws.com/token`.
  - JSON body with camelCase:
    `{ grantType: "refresh_token", clientId, clientSecret, refreshToken }`.
  - Header `Content-Type: application/json`.
  - Rationale: AWS IAM Identity Center OIDC `CreateToken` is an AWS JSON API,
    not a generic form-urlencoded OAuth endpoint. The official AWS docs list
    `Content-type: application/json` and camelCase request fields, and
    `kiro-gateway`'s current implementation sends this same JSON/camelCase
    payload.
  - On a `400` with a new imported SQLite refresh token, retry once with the
    reloaded token.

### MODIFY `src/adapters/kiro.ts`

- Use `resolveKiroApiRegion()` for `https://runtime.{region}.kiro.dev/`.
- Continue using `resolveKiroProfileArn()` for payload/header profile ARN.

### MODIFY `tests/kiro-oauth.test.ts`

Add regression coverage for:

- JSON credential import from `KIRO_CREDS_FILE`.
- Enterprise `clientIdHash` loading from `~/.aws/sso/cache/{hash}.json`.
- AWS SSO OIDC refresh URL/body selection.
- `KIRO_API_REGION` runtime override separate from `KIRO_REGION`.
- SQLite device-registration client credentials and `state` table profile ARN
  region detection.

### MODIFY `tests/oauth-refresh.test.ts`

- Keep existing singleflight/reload tests green.
- Extend temporary env cleanup for new Kiro env vars if needed.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-oauth.test.ts tests/oauth-refresh.test.ts tests/kiro-adapter.test.ts`
- `wc -l src/oauth/kiro.ts src/oauth/kiro-credentials.ts src/adapters/kiro.ts`

## Commit

`fix(oauth): broaden single-account Kiro credential inputs`

## Explicit non-goals

- No opencodex Kiro account pool.
- No account circuit breaker.
- No sticky account routing.
- No write-back to Kiro CLI SQLite in this phase.
