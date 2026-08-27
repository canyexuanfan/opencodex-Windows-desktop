# 040 — wp5: new verbs and filters (#2702, #2704)

Closes: #2702, #2704. Branch: `codex/ocx-new-verbs` off `codex/ocx-dto-fidelity`.

## 040.1 — `#2702`: account pause / resume / strategy / sticky

Server routes are complete; this is purely a missing CLI caller. Note the methods —
the issue says POST, the code says **PUT**:

| Verb | Route | Body |
|---|---|---|
| `ocx account pause --id <id>` | `PUT /api/codex-auth/accounts/pause` | `{id, paused: true}` |
| `ocx account resume --id <id>` | same route | `{id, paused: false}` |
| `ocx account pause-exhausted [--off]` | `PUT /api/codex-auth/accounts/pause-exhausted` | flag |
| `ocx account strategy [<name>]` | `GET` via accounts payload / `PUT|PATCH /api/codex-auth/pool-strategy` | `{strategy}` |
| `ocx account sticky [<n>]` | same route | `{stickyLimit}` |

MODIFY `src/cli/account-extended.ts`: add `cmdPause`, `cmdResume`,
`cmdPauseExhausted`, `cmdStrategy`, `cmdSticky` following the existing `cmdPriority`
shape — `configAndType` -> `resolveBaseUrl` -> `apiJson` -> print or `--json`.

```ts
export async function cmdPause(args: string[], deps: AccountDeps, paused: boolean): Promise<number> {
  const id = takeOption(args, "--id");
  if (!id) throw new CliUsageError("account pause requires --id <accountId>");
  const wantsJson = takeFlag(args, "--json");
  const { baseUrl } = await configAndType(deps);
  const res = await apiJson(baseUrl, "/api/codex-auth/accounts/pause", {
    method: "PUT",
    body: { id, paused },
  });
  if (res.status !== 200) return apiError(res, wantsJson);
  return printData({ ok: true, id, paused }, wantsJson, () =>
    \`${paused ? "paused" : "resumed"} ${id}\`);
}
```

Do **not** re-validate `stickyLimit` client-side. The server owns the 1-100 contract
(`parseAccountPoolStickyLimit`); a duplicated bound is a second thing to keep in
sync, and the 400 is already actionable now that wp2 prints `reason`.

Register in the `cmdAccount` chain (account.ts:298-309) and add the capability
entries. `ACCOUNT_USAGE` no longer exists after wp3, so the help text comes from the
capability table automatically — which is the payoff for ordering wp3 first.

**Sibling gap:** `/api/oauth/accounts/pool` is the same capability for the Anthropic
pool (GUI class 4 in 003) and has no verb either. Add `ocx account provider-strategy`
/ `provider-sticky` (or `--provider` on the same verbs — decide at implementation
time and record the choice) so the two pools are symmetric. A CLI that can steer one
pool and not the other is a trap.

## 040.2 — `#2704`: `logs --conversation`, and the silently-ignored `--model`

### (a) CLI filter

MODIFY `src/cli/observe.ts:60-70`:

```ts
+  const conversation = takeOption(args, "--conversation") ?? takeOption(args, "--conversationId");
   const provider = takeOption(args, "--provider");
   const model = takeOption(args, "--model");
   // ...
-  const qs = query({ provider, model, status, limit });
+  const qs = query({ provider, model, status, limit, conversationId: conversation });
```

The server accepts both spellings (`request-log.ts:1032`:
`params.get("conversationId") || params.get("conversation")`), so accept both on the
CLI too rather than forcing operators to remember which.

Also surface `conversationId` in `formatLog` (observe.ts:48), which prints only
time/status/route/duration today. A conversation filter whose output does not show
the conversation is hard to trust.

### (b) the server-side `--model` hole

`filterRequestLogs` handles `provider`, `conversationId`, `status`, `tail`,
`offset`, `limit` — and **no `model`**. So `ocx logs --model x` is accepted and
silently ignored today. That is worse than an error: it yields wrong conclusions from
correct-looking output.

MODIFY `src/server/request-log.ts` `filterRequestLogs`: add a `model` clause
mirroring the `provider` clause one line above, matching `entry.model` **and**
`entry.attempts[].model` — a request that failed over should match the model that
actually served it, consistent with how `provider` already behaves.

This is the one server-side change in wp5. It is in scope because leaving it means
shipping a CLI whose documented filter lies, which is the class of defect this whole
unit exists to remove.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-account.test.ts` | pause/resume send `PUT` with `{id, paused}`; `strategy`/`sticky` hit `/api/codex-auth/pool-strategy`; a server 400 surfaces its `reason` (wp2 integration) |
| `tests/cli-headless-parity.test.ts` | the new verbs appear in the capability table and in generated help |
| `tests/cli-usage-report.test.ts` | `ocx logs --conversation X` and `--conversationId X` both build `conversationId=X` |
| `tests/management-api-logs-metrics.test.ts` | `model` filter matches `entry.model` and `attempts[].model`; a non-matching model returns no rows |

## Accept criteria

1. Pause, resume, pause-exhausted, strategy, sticky all work from the CLI for the
   Codex pool, and the provider pool has symmetric verbs.
2. `ocx logs --conversation` filters server-side and the output shows the id.
3. `ocx logs --model` actually filters, including failover attempts.
4. All new verbs appear in `ocx capabilities --json`.

