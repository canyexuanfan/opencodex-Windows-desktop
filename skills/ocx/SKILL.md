---
name: ocx
description: Drive a running opencodex (`ocx`) proxy from the CLI — account pools, provider routing, model catalog, usage and cost attribution, request logs, access keys, storage cleanup, and the management API. Use when a task involves controlling or inspecting an opencodex proxy rather than editing the opencodex codebase. Triggers: ocx, opencodex, proxy control, account pool, pause account, pool strategy, provider routing, usage report, cost attribution, access key, request log, conversation trace, storage cleanup, management API.
---

# Operating `ocx`

`ocx` controls a locally running opencodex proxy. Everything the dashboard can do, the CLI can do,
with one deliberate exception recorded under Consent below.

This skill is for **operating** a proxy. Two neighbours cover different jobs: `AGENTS_INSTALL.md`
is for installing one, and the repository `AGENTS.md` is for changing the codebase.

## Start here

```bash
ocx capabilities --json
```

That is the machine-readable index of every verb, the routes it drives, its flags, and whether it
mutates. Read it first rather than guessing a command name — it is generated from the same table
that generates the CLI help, so it cannot describe a verb that does not exist.

Narrow it when you already know what you want:

```bash
ocx capabilities --mutating-only --json      # only state-changing verbs
ocx capabilities --route /api/logs           # which verbs drive one route
```

An unmatched `--route` exits 4 rather than printing an empty success.

## Three steps before any management call

1. `ocx ready --json` — is the proxy up and admitting requests?
2. `ocx status --json` — is this binary the same build as the running proxy? A version skew means
   the help and flags you just read describe a *different* build than the one answering.
3. Then the real command, with `--json`.

Skipping step 2 is how an agent ends up reporting that a flag "does not work" when it simply does
not exist in the running build yet.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error — bad or missing arguments; nothing was sent |
| 4 | not found — the named account, provider, key, or route does not exist |
| 5 | conflict — a lock is held or the state changed under you; usually retryable |
| 1 | everything else, including transport failure and any other HTTP error |

**Never read a printed error with exit 0 as success.** Commands used to print a failure and exit 0;
they no longer do, and a source scan keeps it that way. If you see exit 0, the operation happened.

## Reading a failure

A management failure prints up to three lines: the message, then `reason:`, then `hint:`. The
`reason` is the machine-actionable part — branch on it, not on the prose.

Four named classes are worth handling specifically:

| Reason | What it means | What to do |
|---|---|---|
| `oauth_mutation_busy` | another credential write is in flight (503, `Retry-After: 1`) | retry once after a second |
| `catalog_busy` | a catalog gather is in flight (503, `Retry-After: 1`) | retry once after a second |
| a config-mutation lock reason | a config write holds the lock | retry shortly |
| a credential-conflict reason | the install is broken, not busy | run `ocx doctor`; retrying will not help |

The first two are transient by construction and the server tells you how long to wait. The last is
the one to stop on: repeating it just produces the same error more times.

## Consent: one thing you must not do

**Do not star the repository on the user's behalf.** `ocx inspect star` reads the status, and that
is the entire CLI surface for it. The starring POST requires a real dashboard session precisely so
an agent cannot answer that question for its user — it spends *their* GitHub identity, which no
flag can delegate. Do not route around it with `gh`, a direct HTTP call, or a minted session. If
starring would be useful, say so and let the user decide.

The same boundary covers the session-gated `/api/codex-prompt` writes: read them with
`ocx inspect codex-prompt`, and leave the writes to the dashboard.

## Destructive verbs

`storage cleanup`, `storage trash restore`, and `storage policy run` delete or move the operator's
data. All three refuse without `--yes`, and there is no interactive prompt — a prompt an agent can
answer is not a safety boundary, so the flag is.

The expected sequence is preview, report, then ask:

```bash
ocx storage cleanup --percent 25 --json      # previews; deletes nothing; exits 0
```

Report the count and bytes from that output and get explicit approval before adding `--yes`.
`--mode quarantine` (the default) can be undone with `storage trash restore`; `--mode permanent`
cannot.

## References

| File | Use it for |
|---|---|
| `references/01_management_surface.md` | the full capability → route map (generated) |
| `references/02_json_shapes.md` | response envelopes and error shapes |
| `references/03_recipes.md` | copy-paste sequences for real tasks |
| `references/04_failure_semantics.md` | exit codes, 503 classes, what to retry |

`01_management_surface.md` is generated by `scripts/generate-ocx-skill-surface.ts` and a test fails
if the committed copy drifts from the capability table. When it and the running binary disagree,
believe `ocx capabilities --json`.

