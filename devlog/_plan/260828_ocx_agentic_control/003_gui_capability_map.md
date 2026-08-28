# 003 — GUI capability map and the GUI-only gap

Source: read of `gui/src/**` (React + Vite) against `src/cli/**`.

## The GUI has no central API client

`gui/src/api.ts:265` `installApiAuthFetch()` monkey-patches `window.fetch` and
injects `X-OpenCodex-API-Key`, `X-OpenCodex-GUI-Origin`, and (non-GET only)
`X-OpenCodex-CSRF-Token` for same-origin `/api/*` paths. Session bootstrap reads
meta tags `opencodex-session-token|csrf|origin` (api.ts:93); a 401 silently
re-bootstraps `/opencodex-session`, falling back to an admin-token prompt validated
against `GET /api/settings`.

Endpoint URLs are inlined at roughly **78 call-site files**. There is no manifest to
diff a CLI against, which is why the parity gate in wp3 must be built from a
declared registry rather than harvested from the GUI.

Page shell: 10 top-level pages in `gui/src/app-routing.ts:5` — dashboard, startup,
providers, models, subagents, logs, usage, storage, codex-set, integrations.
Combos, RoutingProfiles and CompatibilityMatrix are **tabs of Models**; Debug is a
**tab of Logs**; ApiKeys is a **tab of Integrations**.

## GUI-only capability classes

Each verified absent from `src/cli/` by endpoint grep.

| # | Capability | Endpoints with no CLI caller | Note |
|---|---|---|---|
| 1 | Codex prompt-layer management | 7 routes under `/api/codex-prompt*` | **Not a CLI target.** The 6 mutating verbs require a dashboard session (403 `dashboard_session_required`). Only `GET /api/codex-prompt` and `/text` are reachable — read verbs are in scope, writes are not. |
| 2 | Storage cleanup, trash, cleanup policy | `/storage/cleanup`, `/cleanup/preview`, `/trash`, `/trash/restore`, `/cleanup-policy` GET+PUT, `/cleanup-policy/run` | `ocx observe storage` reaches only `/api/storage` and `/codex-logs*`. Destructive verbs need a confirm flag. |
| 3 | Codex pool strategy / sticky | `/api/codex-auth/pool-strategy` | #2702 |
| 4 | Anthropic account-pool strategy / sticky | `/api/oauth/accounts/pool` | #2702's sibling; separate route family |
| 5 | Pause / resume a Codex account; pause all exhausted | `/api/codex-auth/accounts/pause`, `/pause-exhausted` | #2702. CLI has `clear-cooldown` and `priority` only |
| 6 | Default-mode request-user-input feature toggle | `/api/codex-auth/features/default-mode-request-user-input` | |
| 7 | Client config snippet generation | `/api/client-config?client=` | `ocx export --client` builds configs locally — different route, different output |
| 8 | Native integrations enable/disable | `/api/native-integrations`, `/{client}` (4 PUTs) | |
| 9 | Rename an access key | `PATCH /api/keys` | Noted in #2705's body as a separate gap |
| 10 | Provider request pacing view | `/api/provider-request-pacing?name=` | |
| 11 | GitHub star status and action | `/api/github/star` GET+POST | **POST must never get a CLI verb** — user-consent boundary per `AGENTS_INSTALL.md`, enforced at sidebar-routes.ts:75. GET status is fine. |
| 12 | Compatibility Lab HTTP surface | 20 read routes under `/api/lab/*` | `ocx lab` reads local SQLite instead. Same data, different transport — capability-present, endpoint-absent |
| 13 | Raw config document PUT | `PUT /api/config` | **Not a target**: deliberate 405 |

## Reclassification after review

Of the 13 classes, three are **not** parity work and must be recorded as
exemptions so the parity test does not demand them:

- class 1 write verbs, class 11 POST — session/consent boundary
- class 13 — deliberate 405

Two are **transport** exemptions rather than capability gaps (class 12, and `ocx
config`'s file-I/O path): the capability exists in the CLI by another route. wp7
decides whether to add an HTTP-backed `--remote` path for them; the default answer
is no, with the exemption recorded and justified.

That leaves **eight real capability gaps** for wp5 and wp7: classes 2, 3, 4, 5, 6,
7, 8, 9, 10 minus the two folded into #2702 (3, 4, 5) which wp5 owns.

## Notable DTO fields the GUI renders and the CLI drops

| DTO | Fields | Issue |
|---|---|---|
| `GET /api/keys` | `usage.requests7d`, `usage.totalRequests`, `lastUsedAt`, `attributionSince`, `historyTruncated`, `authMatrix` | #2705 |
| `GET /api/codex-auth/accounts` | `paused`, `quota.fiveHourPercent`, `health{status,reason,until}`, `usage30d{…}` | #2703 |
| `GET /api/usage` | `accounts[]` | #2700 |
| `GET /api/logs` | `conversationId` filter (server-side) | #2704 |

`gui/src/hooks/useCodexAccountPool.ts:27` is the reference DTO shape for the
account family — the CLI's `AccountRow` at `src/cli/account-api.ts:14` is a strict
subset of it, and `projectQuota` at :195 narrows it further.

