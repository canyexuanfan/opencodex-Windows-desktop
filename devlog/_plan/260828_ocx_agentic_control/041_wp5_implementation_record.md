# 041 — wp5 implementation record: new verbs and filters (#2702, #2704)

Branch: `codex/ocx-new-verbs`, stacked on `codex/ocx-dto-fidelity`.
Plan: `040_phase_new_verbs.md`. Both accept-criteria sets are met; the deviations from the
plan are recorded below rather than silently absorbed.

## What shipped

| Verb / behavior | Route | File |
|---|---|---|
| `ocx account pause <provider> <id>` | `PUT /api/codex-auth/accounts/pause` | `src/cli/account-extended.ts` |
| `ocx account resume <provider> <id>` | same route, `paused: false` | same |
| `ocx account pause-exhausted <provider>` | `PUT /api/codex-auth/accounts/pause-exhausted` | same |
| `ocx account strategy <provider> [<name>]` | codex or anthropic pool (see below) | same |
| `ocx account sticky <provider> [<n>]` | same pair of pools | same |
| `ocx logs --conversation\|--conversationId <id>` | `GET /api/logs` | `src/cli/observe.ts` |
| server-side `model` filter | `filterRequestLogs` | `src/server/request-log.ts` |

## The plan left one decision open, and this is the decision

The plan named the sibling gap — `/api/oauth/accounts/pool` is the same capability for the
Anthropic pool and had no verb either — and explicitly deferred the choice between
`--provider` on the existing verbs and a second `provider-strategy`/`provider-sticky` pair.

**Chosen: one verb pair over both pools**, dispatched on the provider positional that these
verbs already required. A second pair would double the surface an operator has to learn to
express one idea, and the provider argument was already there.

That choice only works because the asymmetry is encoded rather than assumed. The two routes
differ in four ways, and every one of them would have been a live defect under a naive
"same settings, so same call" implementation:

|  | Codex pool | Anthropic pool |
|---|---|---|
| read | `GET /api/codex-auth/active` | `GET /api/oauth/accounts/pool?provider=` |
| write | `PUT /api/codex-auth/pool-strategy` | `PUT /api/oauth/accounts/pool` |
| response keys | `accountPoolStrategy` / `accountPoolStickyLimit` | `strategy` / `stickyLimit` |
| write body | bare field | field **plus a mandatory `provider`** |

The mandatory `provider` is the sharpest one: omit it and the route answers 400
(`oauth-account-routes.ts:344`), so a symmetric implementation would have failed at runtime
on every Anthropic write while passing every Codex test.

`--json` output uses pool-neutral keys (`strategy`, `stickyLimit`) for both pools. A consumer
driving `ocx` programmatically should not have to branch on which pool answered in order to
read the value it just set.

`anthropic` is the only OAuth provider with this setting, and the route says so with a 400.
The CLI refuses any other OAuth provider locally instead of spending a round-trip to learn it.

## The server-side `--model` hole was real

`filterRequestLogs` had clauses for `provider`, `conversationId`, `status`, `tail`, `offset`,
and `limit` — and none for `model`. So `ocx logs --model x` was accepted and every row came
back. That is worse than an error: the output looks filtered, so it yields a wrong conclusion
from correct-looking data.

The new clause matches `entry.model` **and** `entry.attempts[].model`, mirroring the `provider`
clause directly above it, because a request that failed over should be findable by the model
that actually served it.

## Every new gate was driven red before being trusted

Four probes, each reverting a specific decision:

| Probe | Result |
|---|---|
| `model` clause matches top-level only, not attempts | 1 fail — the failover row stopped matching |
| `model` clause deleted entirely (the shipped bug) | 1 fail — `model=absent-model` returned 2 rows where 0 were expected |
| Anthropic `writeBody` drops `provider` | 1 fail — the exact-body assertion caught it |
| Anthropic routed through `CODEX_POOL_TRANSPORT` (assume symmetry) | 3 fails — read path, write body, and `--json` keys all wrong |

The second probe is the one worth keeping in mind: the positive assertion
(`model=gpt-test` returns `["a"]`) passes with **no filter implemented at all**, since an
unfiltered result contains the expected row. Only the non-matching assertion
(`model=absent-model` → `[]`) can detect the shipped defect. A test suite for a filter that
omits the negative case measures nothing.

## Verification

```
bun test tests/cli-account-pool-verbs.test.ts tests/cli-usage-report.test.ts \
  tests/request-log.test.ts tests/cli-capabilities.test.ts tests/cli-headless-parity.test.ts \
  tests/management-route-registry.test.ts tests/request-log-conversation.test.ts \
  tests/management-api-logs-metrics.test.ts
→ 176 pass, 0 fail across 8 files

./node_modules/.bin/tsc --noEmit → clean
```

Live, against the running proxy on :10100:

```
account strategy openai        → openai: pool strategy is quota                (exit 0)
account sticky openai          → openai: sticky limit is 1                     (exit 0)
account strategy anthropic     → anthropic: pool strategy is quota             (exit 0)
account strategy gemini        → Error: unknown provider "gemini" + usage      (exit 1)
account pause openai bogus_id  → Error: Account not found                     (exit 4)
logs --limit 2                 → rows now carry `conv=24f7175…`
```

Two details worth pinning, because both contradict a plausible guess:

**Exit 4, not 1.** A not-found management error exits 4 under the wp3b uniform exit-code
contract; only the usage error exits 1. An earlier draft of this record said 1 for both.

**`gemini` is refused before it reaches the new pool check.** `classifyAccount` rejects it as
an unknown provider first, since it is not configured in this environment. The pool-specific
refusal (`… not "gemini"`) is what a configured-but-poolless OAuth provider gets, and that
path is covered by the unit test rather than by this live run.

**The `--model` hole reproduced live.** The proxy on :10100 runs an older build from a
different checkout, so it still has the unfixed `filterRequestLogs`:

```
logs --model no-such-model --limit 5  → 5 rows, all kiro/claude-opus-5   (exit 0)
```

A nonsense model returning a full page of rows, with exit 0, is exactly the defect #2704
describes — output that looks filtered and is not. The fix is verified against
`filterRequestLogs` directly in `tests/request-log.test.ts`; this live run is the
before-picture, not a regression.

### A note on how these tests were run

Another worktree held the machine test lock (`opencodex-bun-test.lock`) for a full-suite run,
so these ran under `OCX_TEST_NO_QUEUE=1`, which is the documented escape for intentional
overlap (`scripts/test-run-lock.ts:164`). It is sound for this file set: every test injects
`fetchImpl` or calls `filterRequestLogs` directly, so none binds a port, and `tests/preload.ts`
sandboxes `HOME`/`CODEX_HOME` on every invocation regardless of the wrapper.

## Criterion 4: the new surface is in `ocx capabilities`

```
ocx capabilities --json → invocations:
  ocx status, ocx capabilities, ocx provider list, ocx account list, ocx usage,
  ocx account pause, ocx account resume, ocx account pause-exhausted,
  ocx account strategy, ocx account sticky, ocx logs

ocx capabilities --route /api/oauth/accounts/pool
  → ocx account strategy, ocx account sticky   (both, with all four routes listed)
```

`ocx logs` had no capability entry at all before this phase, even though it was already a
shipped command. It gets one here rather than in a later phase, because this phase changed its
filter contract: an entry added later would have documented the fixed behavior without ever
having declared the broken one.

## Deferred, with an owner

`ocx logs --model` now filters correctly, but the `--model` **flag** was already declared in
`observe.ts` usage, so no help change was needed. `#2699` per-account attribution and the
remaining GUI-only Lab routes stay with wp6 and wp7 as declared in the route registry
exemptions.

## Subagent dispatch

Sol-tier subagent spawns continued to fail with 429 rate limits, so the route-method
verification, helper-signature audit, and both red-probe designs in this phase were done
directly against source rather than delegated. Recording the substitution rather than
implying a review that did not happen.
