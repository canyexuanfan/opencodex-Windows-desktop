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
shape (account-extended.ts:637-690).

**Use the real signatures.** They are easy to get wrong, and an earlier draft of this
doc got four of them wrong at once:

| Helper | Real signature | Wrong assumption to avoid |
|---|---|---|
| `apiJson` | `(deps, baseUrl, method, path, body?, options?)` — account-api.ts:88 | not `(baseUrl, path, {method, body})`; method is the **third positional** arg |
| `apiError` | `(json: Record<string, unknown>, fallback: string)` — account-api.ts:123 | takes the json record and a fallback **string**, not the result object and a boolean |
| `configAndType` | `(deps, name)`, **synchronous**, returns a classify result — account-extended.ts:230 | not `await configAndType(deps)` returning `{baseUrl}`; base URL comes from `resolveBaseUrl(deps)` separately |
| `flag` / `flagValue` | `(args, name)` — account-extended.ts:52, :59 | this module has no `takeFlag`/`takeOption`, and does not import `printData` |
| `usage` | `(message?) => number` — account-extended.ts:224 | usage errors return a code; they do not throw `CliUsageError` here |

Also note `status === 0` is the transport sentinel and must be checked **before** the
status comparison, or an unreachable proxy reports as a management error.

```ts
export async function cmdPause(args: string[], deps: AccountDeps, paused: boolean): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requestedId = args.shift();
  if (!name || !requestedId || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  if (classified.type !== "codex") {
    return usage("Error: pause applies to the openai Codex account pool");
  }
  const id = requestedId === "main" ? MAIN_ID : requestedId;

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  const response = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/accounts/pause", { id, paused });
  if (response.status === 0) return proxyUnreachable();
  if (response.status !== 200) {
    return apiError(response.json, `failed to ${paused ? "pause" : "resume"} ${requestedId}`);
  }
  if (wantsJson) console.log(JSON.stringify({ ok: true, provider: name, id, paused }, null, 2));
  else console.log(`${name}: ${requestedId} ${paused ? "paused" : "resumed"}`);
  return 0;
}
```

The other four verbs follow the same skeleton. `cmdStrategy` and `cmdSticky` share
`PUT /api/codex-auth/pool-strategy`, so implement one helper taking the field to set
rather than two near-duplicates.

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
