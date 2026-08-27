# 004 — Per-issue root cause (#2696-#2705)

Verified against `50e955604` / `package.json` 2.35.0. The issues were filed against
2.33.0. **No issue in this set is already fixed on HEAD.** Three issue reports are
inaccurate in ways that change the fix; those are called out.

## #2697 — dispatch discards the exit code

`dispatch.ts:419` (`provider`) and `:428` (`models`) both `await` the handler and
`return 0`. The inner layers are correct: `handleModelsRuntimeCommand` returns
`runCliAction(action)` (models-runtime.ts:337), `runCliAction` maps
`RuntimeApiError` to 1 (runtime-api.ts:321), and `handleModels` (models.ts:434) and
`handleProviderCommand` (provider.ts:477) both set `process.exitCode = code`. The
dispatcher overwrites it, and index.ts:956's `process.exit(0)` makes it final.

Fix: `return Number(process.exitCode ?? 0)` — the pattern already used for `service`
at dispatch.ts:309 and eight other commands.

Correction to the report: its quoted snippet is stale (HEAD uses dynamic
`await import`). Its claim that `account` is unaffected holds — dispatch.ts:426
returns `cmdAccount`'s code directly.

Test: `tests/cli-dispatch.test.ts`, existing `dispatchCommand exit codes` block;
the `service` case at line 80 is the template.

## #2698 — 503 `reason` and `hint` never printed

`responseMessage` (runtime-api.ts:50) returns on the first of `error`/`message`/
`detail` and never reads `reason` or `hint`, which the server supplies at
management-auth.ts:455-459. `runCliAction` prints only `error.message`.

The full body is already on `RuntimeApiError.body` (runtime-api.ts:86) — nothing
needs re-fetching. Fix is one function: append `reason` and `hint` as distinct
lines, keep the 400-char cap on string bodies. Every `runtimeRequest` caller
inherits it. `apiError` (account-api.ts:123) needs the same treatment.

Test: `tests/cli-management-auth.test.ts` already drives `runtimeRequest` against an
injected `fetchImpl`.

## #2696 — launchd aliases the admin token as `OPENCODEX_API_AUTH_TOKEN`

Three files together; no single one is wrong.

- `src/service.ts:464` `buildServiceShellCommand` unconditionally exports
  `~/.opencodex/service-api-token` as `OPENCODEX_API_AUTH_TOKEN` before `exec … start`.
- `src/service.ts:383` `writeServiceApiTokenFile` copies whatever is in
  `process.env.OPENCODEX_API_AUTH_TOKEN` into that file **with no check that the
  value is not an `ocx_admin_…` management token**. Callers: 1887, 2025, 2378, 2576.
- `src/server/management-auth.ts:200` `ready()` -> `isDataPlaneAdmissionSecret`
  fails the **entire** management plane closed; `src/server/auth-cors.ts:349` matches
  the presented admin token against `configuredApiAuthToken()`, which is exactly
  `process.env.OPENCODEX_API_AUTH_TOKEN`.

Behavior: when both hold the same string, boot records
`{available:false, reason:"management credential conflicts with a data-plane credential"}`
and every `/api/*` returns 503 — on a loopback install where `isApiAuthRequired()`
is false and no data-plane token was ever needed. Exporting
`OPENCODEX_ADMIN_AUTH_TOKEN` in the CLI cannot help: the server already fenced the
plane at startup.

Nothing in `src/` writes an admin token into the service token file — the collision
comes from a user shell that had `OPENCODEX_API_AUTH_TOKEN` set to their admin
token. That does not make it user error: `writeServiceApiTokenFile` is the chokepoint
that should refuse.

Fix: refuse at write time (`/^ocx_admin_/` or equal to `configuredAdminToken()`)
with an actionable message; same guard in `assertServiceAuthEnvironment`
(service.ts:369) so `install`/`repair` fail loudly. For existing installs, add a
startup repair: when the two files are byte-identical **and the bind is loopback**,
drop `service-api-token` rather than fencing `/api/*`.

**Security-boundary note:** this touches credential handling, so it needs the
explicit security review `MAINTAINERS.md` requires. The repair path must not widen
admission — it removes a redundant data-plane secret on loopback only, and must not
run for a non-loopback bind. If that cannot be established cleanly, the write-time
refusal ships alone and the repair is deferred.

Tests: `tests/service.test.ts` (already manipulates the env var at 20-28, 264-285);
server-side fail-closed behavior in `tests/server-management-auth.test.ts`.

## #2701 — PATH `ocx` can be older than the running proxy

Not implemented, rather than broken. Both halves exist:

- CLI version: `help.ts:8` `packageVersion()`, used only by `printVersion`.
- Proxy version: `/healthz` returns `version: VERSION` (server/index.ts:959).
- `collectStatus` throws it away: when `findLiveProxy()` succeeds it **skips the
  health fetch entirely** and synthesizes `message: "ok (pid …)"` (status.ts:193-199,
  deliberate race avoidance per the comment at 192). Only the non-live path formats
  `ok v<version>` (status.ts:159). So on a healthy proxy `ocx status` never sees the
  version.
- `LiveProxy` carries pid/port/hostname/source and no version
  (`src/server/proxy-liveness.ts:64`) — even though `isOpencodexHealthz` (:90)
  already validated at :94 that a
  version string was present (line 94).
- `doctor.ts` has no drift check; the only "older" warning is about the Codex binary.

Fix: add `version?: string` to `LiveProxy`, populated in the probe that already
parsed the body — no extra request, no new race. Compare in `collectStatus` against
`packageVersion()`, emit a warning line plus `cliVersion`/`proxyVersion` on
`CliStatusJson`. Mirror in `runDoctor`.

Tests: `tests/cli-status-json.test.ts`, `tests/doctor.test.ts`.

## #2702 — missing pause / strategy / sticky verbs

Pure CLI gap; the routes are complete. `PUT /api/codex-auth/accounts/pause`
(auth-api.ts:1494), `PUT …/pause-exhausted` (:1569),
`PUT|PATCH /api/codex-auth/pool-strategy` (:1676, accepts `strategy` and
`stickyLimit`).

Correction to the report: those are **PUT**, not POST.

The subcommand table at account.ts:298-309 has no `pause`, `pause-exhausted`,
`strategy`, or `sticky`, and `ACCOUNT_USAGE` documents none. Fix follows the
existing `cmdPriority` shape in account-extended.ts. Reuse
`parseAccountPoolStickyLimit`'s 1-100 contract server-side; let the 400 be the
authority rather than re-validating client-side.

Test: `tests/cli-account.test.ts`, or `tests/cli-headless-parity.test.ts` which
exists for exactly this gap class.

## #2703 — `paused` and the 5h window dropped

Three separate drops. The report understates the third, which is the one that
matters:

1. `paused` is absent from `AccountRow` (account-api.ts:14-27) and
   `CodexAccountDto` (:184), so `fetchCodexRows` never reads it (:230-241) even
   though the server always sends it (auth-api.ts:286 pool, :1315 main).
   `statusText` (account.ts:65) can therefore only print `selected`/`needs-reauth`.
2. `refreshLine` gates the whole quota block on weekly/monthly and prints
   `quota: unknown` when only a 5h window exists (account-extended.ts:253). Five
   lines below, `quotaParts` (:275) already renders `5h` correctly for the provider
   path — the two halves of the file disagree.
3. **Not in the issue:** `projectQuota` (account-api.ts:195) whitelists seven keys
   and omits `fiveHourPercent`/`fiveHourResetAt`, so the field is stripped before
   any renderer runs. `quotaText` reads `quota.fiveHourPercent ?? quota.shortPercent`
   (account.ts:89) — the first operand is unreachable on the Codex path. **Fixing the
   renderers alone does not fix the bug.**

Also: `quota` is only populated under `--quota`, because `fetchCodexRows` spreads it
conditionally on `forceRefresh` (:240) and `cmdList` only requests it under
`--quota` (account.ts:166). That is the deliberate #2566 cost decision, not a bug —
but it means "5h in `list`" means "5h in `list --quota`", and the docs must say so.

## #2704 — `logs` has no `--conversationId`

`observe.ts:60-70` parses only `--follow/-f`, `--provider`, `--model`, `--status`,
`--limit`. The server accepts both spellings at request-log.ts:1032:
`params.get("conversationId") || params.get("conversation")`.

The report's second claim is correct and sharper: `filterRequestLogs` handles
`provider`, `conversationId`, `status`, `tail`, `offset`, `limit` — and **no
`model`**. So `ocx logs --model x` is silently accepted and silently ignored, which
is worse than rejecting it. Implement `model` server-side (match `entry.model` plus
`entry.attempts[].model`, mirroring the `provider` clause) rather than rejecting the
flag: a silently-ignored filter produces wrong conclusions from correct-looking
output.

Tests: `tests/management-api-logs-metrics.test.ts` for the server filter; CLI
query construction alongside `handleObserveCommand` coverage in
`tests/cli-usage-report.test.ts`.

## #2705 — access key usage fields dropped

`access.ts:29` formats each key as exactly `id  name  prefix`. The server attaches
`usage: rollup.get(k.id) ?? {requests7d:0, totalRequests:0}`
(oauth-account-routes.ts:586) plus optional `attributionSince` and
`historyTruncated` (589-590).

Two things the fix must get right, both already encoded server-side:

- `ApiKeyUsage` is a **discriminated union** (api-key-usage.ts:15):
  `{ambiguous:true}` carries no numbers, and the comment at line 11 is explicit that
  rendering a number beside an ambiguity marker is the failure mode to avoid. Print
  `ambiguous`, never `0`.
- `lastUsedAt` is optional; absent means "not used within the read window", which
  `attributionSince` exists to disambiguate. Print it once as a footer.

`--json` already works (`printData` dumps the raw payload, runtime-api.ts:288).
Only the human branch is lossy.

## #2700 — usage report omits `accounts[]`

`UsageReportInput` (usage-report.ts:23-41) has no `accounts` field and
`formatUsageReport` renders only summary, providers, models (PROVIDER table at
usage-report.ts:119, MODEL at :129). The server includes `accounts`
(`UsageSummary.accounts`, summary.ts:126; the read-failure fallback ships
`accounts: []` at logs-usage-routes.ts:334), and `observe.ts:153` passes the payload
straight through.

**Important qualification — `accounts` is NOT unconditional.**
`projectUsageSummary` sets `accounts: []` whenever a provider or model filter is
active (summary.ts:943, reasoned at :865-872): account rows are not
provider-partitioned in a way the projection could honestly re-derive, and
unfiltered account totals beside filtered model totals would invite the wrong
reading. That is a deliberate correctness choice, not a bug.

It matters for this unit because `ocx usage --provider xai --json` is exactly how an
agent would check per-account spend for one provider, and it returns an empty
`accounts` array with no explanation. wp4 must render that state explicitly rather
than as an empty table.

Fix: add the field and one `table([...])` block after PROVIDER, filtered to
`requests > 0`. Render `legacy-ambiguous` rows with a marker — `ambiguous` is on the
DTO (summary.ts:97) for exactly that reason. Single file, no server change.

## #2699 — per-account usage not persisted for OAuth providers

The label type is Codex-only by construction:

- `src/usage/log.ts:14`: `type CodexUsageAccountLogLabel = "main" | \`p${string}\``,
  validated at :16 against `CODEX_ACCOUNT_LOG_LABEL_RE` = `/^p[a-f0-9]{6}$/`
  (`src/codex/account-label.ts:6`).
- Every writer drops a non-matching label: usage/log.ts:369, :456,
  server/request-log.ts:262, :381.
- The only producer, `codexAuthContextLogLabel` (account-label.ts:32), returns
  `undefined` for anything that is not a Codex `pool`/`main-pool` context.
- Attribution fallback also refuses: `legacyCodexAccountLabel` (summary.ts:681)
  returns `null` unless `baseProviderLabel(provider) === "openai"`, so `buildAccounts`
  drops the row at :706.

The identity is already in hand and never stamped: `core.ts` resolves
`resolved.accountId` from the OAuth snapshot and keeps it in
`genericFailoverAccountId` (core.ts:2888) purely for 429 cooldown attribution.
Anthropic already encodes its account into the provider label (core.ts:2876
`formatAnthropicProviderForLog`) — so xai/cursor are the gap, not OAuth generally.

Fix, privacy-preserving:

1. Widen the label to a discriminated form: keep `"main" | p<hex6>` for Codex, add a
   provider-scoped `o<hex6>` derived via `sha256(accountId)`, reusing the shape of
   `fallbackCodexAccountLogLabel` (account-label.ts:17). Rename the type off
   `Codex…` and widen the regex in one place.
2. Stamp `logCtx.accountLogLabel` in `core.ts` beside the existing
   `genericFailoverAccountId` assignment, and again after each rotation site
   (4328, 4629, 5221) so a rotated request attributes to the account that served it.
3. Let an explicit non-Codex label survive `accountLabelForAttribution` in
   summary.ts. Leave `legacy-ambiguous` behavior for unlabeled openai rows alone.
4. **Never persist emails.** The log path carries only the hash; `maskEmail` stays
   on display paths.

`supportsPerAccountQuota` (providers/quota.ts:1454, currently `=== "anthropic"`) is
a separate concern and out of scope here.

This is the only issue in the set that touches the request path
(`src/server/responses/core.ts`) and the shared usage-log schema, so per
`AGENTS.md` it needs full `bun run typecheck` and `bun run test` rather than a
focused check. The operator suspended local suite runs for this loop, so that
validation lands in wp9's CI pass — recorded here so the exception is explicit
rather than forgotten.

## Landing order

| Wave | Issues | Rationale |
|---|---|---|
| 1 | #2697, #2698, #2701 | Diagnosability. Non-zero exits, full 503 text, version drift — small, and they make everything after them verifiable. |
| 2 | #2696 | The fail-closed collision, verified through wave-1 output. Security review required. |
| 3 | #2703 + #2702, #2704, #2705 | Independent surface gaps. 2703/2702 share files and land together. |
| 4 | #2699 -> #2700 | #2700's table is only meaningful for xai/cursor once #2699 stamps labels. |
