# 060 — wp7: residual GUI-parity closure

Branch: `codex/ocx-gui-parity` off `codex/ocx-account-attribution`.

wp5 closed the account-pool gaps. This phase closes the rest of 003's inventory so
the parity test in wp3 can run with an empty unexplained-gap set.

## The remaining gaps

| 003 class | Capability | New verb | Route(s) |
|---|---|---|---|
| 2 | storage cleanup preview/run | `ocx storage cleanup [--percent N] [--preview] [--yes]` | `POST /api/storage/cleanup/preview`, `POST /api/storage/cleanup` |
| 2 | storage trash list/restore | `ocx storage trash [list]`, `ocx storage trash restore <entry>` | `GET /api/storage/trash`, `POST /api/storage/trash/restore` |
| 2 | cleanup policy | `ocx storage policy [show]`, `policy set …`, `policy run` | `GET|PUT /api/storage/cleanup-policy`, `POST /cleanup-policy/run` |
| 6 | default-mode request-user-input | `ocx agent request-user-input [on|off]` | `GET|PUT /api/codex-auth/features/default-mode-request-user-input` |
| 7 | client config snippet | `ocx integration client-config --client <id>` | `GET /api/client-config` |
| 8 | native integrations | `ocx integration native [list]`, `native <client> on|off` | `GET /api/native-integrations`, `PUT /{client}` |
| 9 | rename an access key | `ocx access key rename --id <id> --name <name>` | `PATCH /api/keys` |
| 10 | provider request pacing | `ocx provider pacing [--name <p>]` | `GET /api/provider-request-pacing` |
| — | codex prompt read | `ocx codex-prompt show [--text]` | `GET /api/codex-prompt`, `/text` |
| — | github star status | `ocx status --star` or `ocx system star-status` | `GET /api/github/star` |

Also worth adding while the surface is open, since each is a route with no verb found
in 001's family table:

- `ocx system settings [set …]` -> `GET|PUT /api/settings` (partially covered today)
- `ocx system windows-replace-retries` -> `GET /api/system/windows-replace-retries`
- `ocx account failover` -> `PUT /api/codex-auth/failover`. Note `auto-switch` and
  `reset-credits` already exist (account.ts:302, :313) — do not re-add them
- `ocx models discovery ack` -> `POST /api/model-discovery/acknowledge`
- `ocx request-history` -> `GET /api/request-history`, `/{id}`, `/{id}/route-decision`
  (`ocx observe` reaches only the route-decision variant)

The exact list is settled at implementation time by running wp3's parity test and
reading its failure output. **That is the phase's method:** the test names the gaps,
so this doc does not need to pre-guess a list that would go stale.

## Destructive-verb rules

`storage cleanup`, `storage policy run`, and `trash restore` delete or move operator
data. Rules for all three:

1. Default to preview. `ocx storage cleanup` without `--yes` runs the preview route
   and prints what *would* be freed, then exits 0 without mutating.
2. `--yes` is required to mutate. No interactive prompt — an agent cannot answer one,
   and a prompt an agent can answer is not a safety boundary (the reasoning in
   `AGENTS.md` §User-consent actions).
3. `--json` on the preview emits the exact target list, so an agent can decide.

This is the opposite of the star POST: cleanup spends the operator's *data*, which a
flag can authorize, while the star spends their *identity*, which no flag can.

## Not parity targets

Recorded as exemptions in wp3's registry with these reasons, so the test passes
without them:

- `POST /api/github/star` — `session-only`, user-consent boundary. GET is added; POST
  never will be.
- the 6 mutating `/api/codex-prompt*` verbs — `session-only` (403
  `dashboard_session_required`). Read verbs are added.
- `POST /api/providers/reload` — `capability-principal`.
- `PUT /api/config` — `disabled` (405).
- the 2 `test-stream` routes — `test-seam`.
- 20 `/api/lab/*` reads — `local-transport`; `ocx lab` reads the same projection from
  SQLite. **Decision recorded here:** no `--remote` HTTP path is added. A second
  transport for the same data doubles the surface for an agent that already has the
  local one, and a remote agent is not a supported topology today.
- the shadowed `GET /api/storage` in `logs-usage-routes.ts:346` — `dead`. Delete it in
  this phase rather than exempting it; an unreachable duplicate is a trap for the next
  reader.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-api-parity.test.ts` | passes with zero unexplained gaps |
| `tests/cli-storage.test.ts` (NEW) | cleanup without `--yes` calls only the preview route; with `--yes` calls the mutating route; trash restore targets the named entry |
| `tests/cli-headless-parity.test.ts` | each new verb hits its declared route and honors `--json` |
| `tests/management-api-*.test.ts` | the deleted shadowed route changes no observable behavior |

## Accept criteria

1. `tests/cli-api-parity.test.ts` passes with every route either covered or
   exempted with a reason.
2. No destructive verb mutates without `--yes`.
3. The dead route is gone and no test regressed.
4. `ocx capabilities --json` lists every new verb.
