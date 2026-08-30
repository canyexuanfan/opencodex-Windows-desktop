# 090 — wp10: close the gap-audit findings

The wp9 close-out gap audit answered YES to "does a material gap remain in agentic CLI
control of GUI capabilities", with three High findings and one Medium. Each was
independently reproduced against source before this plan was written, so none of it is
taken on the reviewer's word.

Reproductions (run from the branch, not the released `ocx` on PATH — the first attempt at
this measurement used the installed binary and got "Unknown command: capabilities", which
is a stale build, not evidence):

```
bun run src/cli/index.ts capabilities --route /api/keys --json  -> {"capabilities": []}, exit 4
bun run src/cli/index.ts logout --json                          -> "Logged out of --json.", exit 0
bun run src/cli/index.ts definitely-not-a-command               -> exit 1
capabilities declared: 26   routes declared: 207
```

## 090.1 — `logout --json` silently no-ops (highest severity)

`src/cli/dispatch.ts` `logout` takes `args[1]` as the provider name with no flag parsing, so
`ocx logout --json` lowercases `--json`, calls `removeCredential("--json")`, prints
`Logged out of --json.` and exits 0. An agent gets a success exit for an operation that did
nothing, which is the worst failure mode in this whole unit: silent, and indistinguishable
from success.

**Plan audit correction.** My first reading called `removeCredential("--json")` harmless
because `store.ts:598` returns early on an unknown key. That is wrong for a store this code
does not control: `normalizeAuthStore` (`store.ts:346-355`) copies **every** top-level key
it finds, so a hand-edited, legacy, or corrupted `auth.json` containing a `--json` key would
have its active account deleted — and the key removed entirely if that was its last account.
The severity is therefore "can destroy credentials in an unusual but reachable store", not
"wastes a call". Recorded because it changes what the regression has to prove.

Fix: parse flags out of argv **before any store I/O**, and split the outcomes the vocabulary
already distinguishes rather than collapsing them:

| Case | Exit |
|---|---|
| omitted provider, unknown flag, invalid argument | 2 (usage), before touching the store |
| valid provider name with no stored credential | 4 (not found) |
| removed | 0 |

The regression must assert that a malformed invocation causes **zero** store mutation, not
merely a non-zero exit.

## 090.2 — three GUI capabilities have no CLI equivalent

| GUI call | CLI today | Missing verb |
|---|---|---|
| `POST /api/oauth/logout` | `ocx logout` only calls `removeCredential` locally | API-backed logout |
| `GET /api/system/codex-app-server`, `POST /api/system/codex-restart` | `sync --restart-codex` only as a side effect after a write | `system codex-app-server status` / `restart` |
| `GET /api/claude-desktop/status` | `claude desktop show` emits locally-built state only | `claude desktop status` |

The OAuth one is not cosmetic. The route does five things past `removeCredential`:
`reconcileLiveStateStores`, `clearLoginState`, `clearModelCache`,
`clearGatherRoutedModelsInflight`, and quota-cache eviction
(`oauth-account-routes.ts:228-243`). A CLI logout that skips them leaves a running proxy
serving a removed credential's cached models and quota, so the local-only path is a
correctness gap and not just a parity gap.

**Plan audit correction — the stopped-proxy contract was missing, and it is the whole
design question.** An API-backed verb needs a live proxy; discovery failure throws
"Proxy is not running" (`runtime-api.ts:43`). So this phase must state the behaviour:

- Proxy running: go through `POST /api/oauth/logout` so the five invalidations happen.
- Proxy not running: exit non-zero, say how to start it, and **mutate nothing**.

No automatic local fallback. A best-effort fallback is actively dangerous here: if a proxy
is alive but momentarily undiscoverable, falling back would delete the credential on disk
while that proxy keeps serving its cached models, login state and quota — the precise
divergence the API path exists to prevent. An offline mode is acceptable only as an explicit
opt-in that proves no proxy is live, not as error recovery.

Two further under-specifications to settle before implementing:

- The route reports success even when nothing was removed, because `removeCredential`
  returns no disposition (`oauth-account-routes.ts:231`). Exit 4 is impossible until the
  store or route returns a removed/not-found result. Do it there, not via a CLI preflight
  read — a preflight is racy by construction.
- Define whether logout removes only the active account or all of them, and whether legacy
  `ocx logout` becomes an alias or keeps its offline behaviour. Silence here is how two
  commands end up meaning different things.

## 090.3 — the parity gate only checks one direction

`tests/cli-capabilities.test.ts` asserts every capability's route exists. It never asserts
the converse, so 139 non-exempt routes carry no capability entry and nothing fails. The
observable consequence is that `capabilities --route` — the agent's discovery entry point —
returns empty and exits 4 for `/api/keys` and `/api/routing-profiles` while `ocx access key`
and `ocx route policy` work.

**Plan audit correction — the allowlist was the wrong mechanism, and the counts were off.**
`ManagementRoute` already carries an `exempt` field with a typed `ExemptionReason` union
(`route-registry.ts:24-46`, `:68`) covering exactly the categories a parallel allowlist would
have re-invented: `session-only`, `disabled`, `capability-principal`, `test-seam`,
`local-transport`, `dead`. A second list would duplicate the source of truth and relocate the
omission problem rather than close it.

The reverse gate is therefore: **every route is either covered by `capabilityRouteKeys()` or
carries a justified `route.exempt`** — never neither, and ideally never both.

The audit's fresh counts also correct mine: 206 routes (I said 207), 35 capability-covered
route keys, 32 exempt, 139 unexplained. More importantly it disproved my framing of what
those 139 are: 122 of them are already referenced from CLI source, and of the remaining 17
about 15 are operator-facing. So the split is roughly ~137 user-facing to ~2 genuine plumbing
(`/api/update/badge`, `/api/system/windows-replace-retries`) — not 139 internal exceptions.

That changes the work: most of these need a capability declaration, not an exemption. Since
139 declarations will not land in one phase, the gate goes in with the currently-known
user-facing families declared (access keys, routing profiles, provider CRUD/test, custom
models/visibility/presets/discovery, injection and subagent settings) and the remainder
marked with a bounded deferred exemption that names an owner — so the debt is visible and
dated rather than silent.

## 090.4 — `--json` and exit codes still not uniform

- `doctor --json` is documented in the skill's recipes but `runDoctor` only looks for its own
  flags; `--json` is ignored and human output is printed.

  **Plan audit correction — this is a refactor, not a flag.** I filed it beside two one-line
  fixes, which understated it badly. `runDoctor` has no report collection at all: it keeps a
  module-level failure bit and emits directly through ~90 `console.log` calls across a
  1,309-line surface (`doctor.ts:73`), and `dispatch.ts:175` appends the Codex Log Guard's
  human output *after* `runDoctor` returns. Adding a JSON print would therefore emit human
  lines and a JSON document on the same stdout — invalid output, worse than the ignored flag.
  My flag inventory was also incomplete: `--yes`, `--reclaim-response-temps` and reclaim-flag
  typo detection exist too (`doctor.ts:1028`).

  Doing it properly needs a structured report DTO, separate human and JSON renderers, Log
  Guard output folded into the report rather than printed alongside it, a stable schema,
  exit derivation from collected findings, unknown-flag rejection, and a decision for
  `--json` combined with each mutating recovery mode. **Split to its own work-phase (wp11).**
  What lands in wp10 is the honest interim: `doctor` rejects `--json` with the usage exit and
  a message saying it is not yet supported, and the skill recipe stops recommending it. A
  documented flag that silently does nothing is the defect; refusing it is not ideal but it is
  not a lie.
- JSON-mode API failures print `Error: …` on stderr and discard the structured body
  (`runtime-api.ts:333`), contradicting the error envelope the skill promises.
- Unknown command exits 1, but the declared vocabulary says 2 for usage.

## 090.5 — the skill test validates command heads only

`tests/skill-ocx.test.ts` reduces each documented invocation to its leading `ocx <word>`
before checking it, so a nonexistent subcommand or an ignored flag passes. `doctor --json`
is exactly that case: head exists, documented flag does nothing.

**Plan audit correction — there is no full-invocation oracle to validate against.** I wrote
"validate full invocations" without checking what could answer the question. `CAPABILITIES`
does carry structured command paths and flags, but only for the 26 declared capabilities
(`capabilities.ts:48`); `src/cli/registry.ts` holds only top-level commands and free-form
usage strings, and the real subcommand parsers are scattered across command modules.
Appending `--help` is not an oracle either: `root.ts:40` intercepts help before subcommand
dispatch, so a nonexistent subcommand still prints help and exits 0.

So the achievable scope for wp10 is narrower and stated as such: validate every documented
invocation **that maps to a declared capability** against that capability's command path and
flag list — a real oracle, covering 26 capabilities — and assert that any invocation outside
that set is explicitly listed as unverified rather than silently reduced to its head. A
hand-maintained subcommand table is refused: it would be a third drifting source of truth.

The general answer is a declarative command grammar shared by parsing, help, capabilities and
skill generation. That is real work and belongs with the doctor refactor in wp11, not smuggled
into this phase.

Also: `skills/ocx/SKILL.md` calls the generated map "every verb" while the map contains 26
capabilities. Either the claim narrows or the map grows; it cannot stay as-is.

## Accept criteria

1. `ocx logout` never reads a flag as a provider name, and a malformed invocation mutates the
   credential store **zero** times — asserted directly, not inferred from the exit code.
   Usage errors exit 2 before any I/O; a valid provider with no stored credential exits 4.
2. The three missing verbs exist, are API-backed, declare capabilities, and emit `--json`.
   With the proxy stopped they exit non-zero, explain how to start it, and mutate nothing;
   there is no automatic local fallback.
3. Logout returns a removed/not-found disposition from the store or route, so exit 4 is real
   rather than assumed, and the active-account-vs-all-accounts semantics are written down.
4. The parity gate fails when a route is neither capability-covered nor `route.exempt`-
   justified, using the existing `ExemptionReason` union rather than a parallel allowlist.
5. `capabilities --route` resolves for every family named in 090.3 that has a working CLI
   command; the rest carry a bounded deferred exemption naming an owner, so the debt is dated
   rather than silent.
6. JSON-mode API failures emit the documented error envelope instead of a bare stderr line.
7. `doctor --json` is refused with the usage exit and the skill recipe no longer recommends
   it; the structured-report refactor is wp11, not this phase.
8. The skill test validates full invocations against the capability oracle where one exists,
   and every invocation outside it is explicitly listed as unverified.
9. Every new assertion is driven red before being trusted.
