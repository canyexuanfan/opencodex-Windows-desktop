# 001 — Management API route inventory

Source: read of `src/server/management-api.ts`, `src/server/management/*`,
`src/codex/auth-api.ts`, `src/codex/native-profile-api.ts` at `50e955604`.

## How dispatch works

There is no route table and no framework. Every route is a hand-written
`if (url.pathname === … && req.method === …)` inside one of 17 handler functions,
chained with `??` in `src/server/management-api.ts` around line 220. First handler
returning non-`null` wins; a handler returning `null` falls through. **Dispatch is
order-sensitive.**

Auth is applied *before* dispatch, in `src/server/index.ts` near line 1010: every
`/api/` path passes `requireManagementAuth`. No management route is unauthenticated.
Individual routes then re-check the principal for consent.

`pathInManagementNamespace` (management-api.ts:102) matches exact-or-child only, so
`/api/labfoo` deliberately does not match `/api/lab`.

## Totals

- **183 reachable routes** across 19 files; **108 mutating**.
- **1 dead route**: `GET /api/storage` at `logs-usage-routes.ts:346` is shadowed by
  the identical claim at `storage-log-guard-routes.ts:150`, which runs earlier in the
  chain and always returns. The live payload is the guard version (scan plus
  `codexLogs`/`codexLogsError`). Audit parity against the guard version.
- `/api/codex-auth/*` is gated by a `startsWith("/api/codex-auth/")` check with a
  trailing slash, so a bare `/api/codex-auth` 404s.

## Auth classes

| Class | Meaning | Routes |
|---|---|---|
| admin | admin token or GUI session (default gate) | ~177 |
| session | minted GUI session required; admin token gets 403 | `POST /api/github/star`, the 6 non-GET `/api/codex-prompt*` verbs |
| cap | process-scoped HMAC capability principal | `POST /api/providers/reload`; read-cap for `/api/codex-auth/accounts` and `/api/system/memory` |

The capability principals are narrow and replay-protected: local reads are limited
to exactly those two paths with `url.search` required empty
(`src/lib/local-management-capability.ts:10`).

## Registration mechanisms a naive `rg '/api/'` misses

| Mechanism | Where | What is missed |
|---|---|---|
| Lazy `import()` behind a namespace check | management-api.ts:115, :121 | all `/api/routing-profiles*` and `/api/lab*` — deliberate, eager mounting would pull ~70 `src/lab/` modules into every install |
| Handlers mounted outside the `??` chain | management-api.ts:284, :289 | 10 `/api/native-main-profiles/*` and 22 `/api/codex-auth/*` routes, which live in `src/codex/` |
| Path constants, not literals | `src/lib/codex-restart-contract.ts:17`, `system-restart-contract.ts:5`, `local-provider-reload-contract.ts:5` | `/api/system/codex-restart`, `/api/system/codex-app-server`, `/api/system/restart`, `/api/providers/reload` |
| Prefix-decoded wildcard | integration-routes.ts:129 | `GET|PUT /api/client-integrations/{clientId}` |
| Regex params | model-routes, lab-routes, lab-automation-routes | 7 routes |
| Suffix matching | request-history-routes.ts:131 | `/route-decision` found via `endsWith` |
| Namespace guards that swallow siblings | codex-prompt:278, request-history:47, lab:285 | unmatched children 404 from index.ts rather than falling through |

**This table is the parity test's hard requirement.** A parity test that greps for
`'/api/…'` string literals would miss 40+ routes and pass vacuously. The test must
enumerate from a declared registry, not from source text.

## Route families (grouped for CLI parity)

| Family | Routes | Existing CLI reach |
|---|---|---|
| config/settings | `/api/config` (GET; PUT=405), `/api/settings` GET+PUT, `/api/diagnostics/project-config`, `/api/sync` | `ocx system`; `ocx config` is file-I/O only, never calls `/api/config` |
| startup/tray | `/api/startup-health`, `/api/startup-action`, `/api/windows-tray` GET+POST | `ocx system` partial |
| update | `/api/update/check`, `/run`, `/status`, `/badge` | `ocx system`, `ocx update` |
| sidecar/shadow | `/api/sidecar-settings` GET+PUT, `/api/shadow-call-settings` GET+PUT | `ocx agent`, `ocx models` |
| storage | `/api/storage`, `/cleanup`, `/cleanup/preview`, `/trash`, `/trash/restore`, `/cleanup-policy` GET+PUT, `/cleanup-policy/run`, `/codex-logs` +4 actions | `ocx observe storage` reaches only `/api/storage` and `/codex-logs*` |
| logs/debug/usage | `/api/logs`, `/api/debug` GET+PUT, `/debug/logs`, `/debug/usage-logs`, `/debug/injection-logs`, `/api/claude/inbound-debug`, `/api/usage` | `ocx observe`, `ocx debug` |
| request history | `/api/request-history`, `/{id}`, `/{id}/route-decision` | `ocx observe` partial |
| routing | `/api/routing-profiles` GET+PUT+DELETE, `/dry-run`, `/api/routing-analytics` | `ocx route policy` |
| providers | `/api/providers` GET+POST+PATCH+DELETE, `/test`, `/reload` (cap), `/api/provider-quotas`, `/api/provider-presets`, `/api/provider-context-caps` GET+PUT, `/api/provider-request-pacing` | `ocx provider`; pacing has no verb |
| models | `/api/models`, `/api/catalog`, `/api/aliases`, `/api/default-aliases`, `/api/providers/{n}/alias`, `/model-aliases`, `/api/disabled-models`, `/api/model-visibility`, `/api/custom-models` +2, `/api/selected-models` GET+PUT, `/api/model-presets` GET+PUT, `/api/model-discovery` GET+PUT, `/acknowledge`, `/api/client-config` | `ocx models`, `ocx alias`, `ocx export`; `/api/client-config` has no verb |
| combos | `/api/combos` GET+PUT+DELETE | `ocx combo` |
| integrations | `/api/client-integrations` +journal +restore +`{clientId}` GET/PUT, `/api/native-integrations` +4 PUTs, `/api/claude-code` GET+PUT, `/api/claude-desktop` GET+PUT +apply +status, `/api/grok` +selection +apply | `ocx integration`, `ocx grok`, `ocx claude`; native-integrations has no verb |
| agent settings | `/api/v2` GET+PUT, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`, `/api/codex-auth/features/default-mode-request-user-input` | `ocx agent`, `ocx v2`; the feature flag has no verb |
| access keys | `/api/keys` GET+POST+PATCH+DELETE | `ocx access key` list/create/remove; PATCH rename has no verb |
| oauth accounts | `/api/oauth/providers`, `/api/key-providers`, `/api/oauth/login` +cancel +code, `/status`, `/logout`, `/api/oauth/accounts` GET+DELETE, `/active`, `/pool` GET+PUT, `/clear-cooldown`, `/import`, `/alias`, `/api/providers/keys` +active +alias | `ocx account`; `/pool` (strategy/sticky) has no verb |
| codex auth | 22 routes: accounts GET/DELETE, `/alias`, `/pause`, `/priority`, `/pause-exhausted`, `/clear-cooldown`, `/active` GET+PUT, `/auto-switch`, `/pool-strategy`, `/failover`, `/quota`, `/reset-credits` +consume, `/login` +code +cancel, `/login-status` | `ocx account`; pause, pause-exhausted, pool-strategy, failover have no verb. `auto-switch` (account.ts:302 -> `cmdAutoSwitch`) and `reset-credits` (account.ts:313) DO have verbs — verified; an earlier draft wrongly listed them as gaps |
| native main profiles | 10 routes under `/api/native-main-profiles` | `ocx account main` |
| system | `/api/system/memory`, `/windows-replace-retries`, `/restart`, `/codex-app-server`, `/codex-restart`, `/api/stop` | `ocx restart`, `ocx stop`, `ocx observe memory` |
| lab | 20 read routes + `/public/*` 4 + automation 5 | `ocx lab` reads local SQLite, never the HTTP routes |
| sidebar | `/api/github/star` GET+POST(session) | GET has no verb; POST must never get one |

## Cross-cutting error envelopes

From management-api.ts:237 — a CLI client should encode these once:

- `413 request body too large` (2 MB cap)
- `403 cross-origin request blocked`
- `503 oauth_mutation_busy`, `503 catalog_busy` (both with `Retry-After: 1`)
- `503 CONFIG_MUTATION_LOCK_UNAVAILABLE` for the codex-auth family
- `503` with `reason` + `hint` from `src/server/management-auth.ts:455`

The last one is #2698: the fields exist and the CLI does not print them.
