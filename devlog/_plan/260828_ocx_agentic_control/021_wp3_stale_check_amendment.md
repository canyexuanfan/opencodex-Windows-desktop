# 021 — wp3 P-phase stale-check amendment

Four parallel read-only Sol explorers checked `020` against the tree at `43b0788e0`.
All four returned VERDICT: FAIL. Every blocking finding below was re-verified
independently against source before being accepted; the counts here are ones
reproduced directly, not ones handed over.

`020` is not withdrawn. Its design — one capability table, three consumers — survives
intact. What failed is the measurement layer: the numbers it reasons from, and the
arithmetic identity of the gate it calls its own central claim.

The single root cause: **`020` and `001` count grep lines and call them routes.** Every
blocking finding is a consequence.

## A1 — check 3's identity cannot balance (blocking)

`020` specifies:

```
registryRoutesFor(module).length === literalCountIn(module) + nonLiteralAllowlist[module].length
```

This fails on today's correct tree, in four independent ways:

| Failure | Evidence |
|---|---|
| A literal line can carry two routes | `oauth-account-routes.ts:332` and `codex/auth-api.ts:1676` both match `PUT \|\| PATCH` |
| 19 literal lines carry no inline method | method decided by an enclosing block: `lab-routes.ts:296,309,322,336,354,358,370,385,411,441,471,516`, `storage-log-guard-routes.ts:112,128,135,140,145`, `integration-routes.ts:313,373` |
| 2 live routes use a **negated** guard and appear in no literal count | `storage-log-guard-routes.ts:150` (`GET /api/storage`), `routing-analytics-routes.ts:26` (`GET /api/routing-analytics`) |
| One module has 1 route and 0 literals | `routing-analytics-routes.ts` — a literal-count-keyed test omits the module entirely |

The negated guards, confirmed directly:

```
$ rg -n 'pathname !== "' src/server/management/*.ts
storage-log-guard-routes.ts:150:  if (url.pathname !== "/api/storage" || req.method !== "GET") return null;
routing-analytics-routes.ts:26:  if (url.pathname !== "/api/routing-analytics" || req.method !== "GET") return null;
```

The second is the finding that matters most. `020` proposes the `===` scan specifically
to stop a vacuous pass, and that scan cannot see `/api/routing-analytics` at all.
Worse, for `GET /api/storage` the scan sees **only the dead shadowed copy** at
`logs-usage-routes.ts:346` and never the live one. A gate built as written would
mistake the corpse for the patient.

**Amendment.** Reconcile on distinct `(method, path)` pairs, never on `rg` line hits.
The scanner must:

1. match both `pathname === "…"` and `pathname !== "…"` forms;
2. resolve the method from the same line, else the two following lines, else the
   enclosing block — and **fail loudly when it cannot resolve one**, rather than
   defaulting to GET;
3. expand `X || Y` method disjunctions into separate pairs;
4. key the per-module allowlist by `(method, path, mechanism)`, so the mechanism is
   recorded per route rather than per module.

Requirement 2's fail-loud clause is the one to defend in review. A scanner that
silently guesses a method is a scanner that reports a number nobody can trust, which
is how `001` arrived at figures no one can reproduce.

## A2 — "188 literals" and "40+ invisible" contradict each other (blocking)

Both cannot be true, because the 188 was measured over a **wider file set** than the
one the "40+" claims are invisible from.

```
$ rg -o 'pathname === "' src/server/management-api.ts src/server/management/ | wc -l
159
$ rg -o 'pathname === "' src/server/management-api.ts src/server/management/ \
    src/codex/auth-api.ts src/codex/native-profile-api.ts | wc -l
188
```

The 159 was reproduced independently before any explorer's number was read. The
29-line difference is `src/codex/auth-api.ts` (20) and `src/codex/native-profile-api.ts`
(9) — the exact files whose routes `001` counts as "invisible because mounted outside
the `??` chain." They are invisible to a scan **scoped to `src/server/management/`**,
and plainly visible in the scan that produced 188.

**Amendment.** The genuinely non-literal count is **18**, enumerated with mechanism
and `file:line` below. State the file set explicitly wherever a count appears: 21
route-carrying files, of which 20 contain literals.

| # | Route | Mechanism | Site |
|---|---|---|---|
| 1 | `GET /api/storage` | negated guard | `storage-log-guard-routes.ts:150` |
| 2 | `GET /api/routing-analytics` | negated guard | `routing-analytics-routes.ts:26` |
| 3 | `GET /api/system/codex-app-server` | path constant | `system-routes.ts:164` |
| 4 | `POST /api/system/codex-restart` | path constant | `system-routes.ts:165` |
| 5 | `POST /api/providers/reload` | path constant | `provider-routes.ts:467` |
| 6-7 | `GET\|PUT /api/client-integrations/{clientId}` | prefix decode | `integration-routes.ts:130` |
| 8 | `GET /api/request-history/{id}` | `pathname.slice` | `request-history-routes.ts:176` |
| 9 | `GET /api/request-history/{id}/route-decision` | `endsWith` | `request-history-routes.ts:131` |
| 10-13 | provider alias, model-aliases, custom-model PUT/DELETE | regex | `model-routes.ts:264,291,606,678` |
| 14-16 | lab subjects/events/artifacts by id | regex | `lab-routes.ts:424,499,545` |
| 17 | `POST /api/lab/automation/runs/{id}/cancel` | regex | `lab-automation-routes.ts:106` |
| 18 | `POST /api/system/restart` | **literal** — `001` wrongly calls it a path constant | `system-routes.ts:133` |

Regex routes are **8**, not `001`'s 7. Native-main-profiles is **9**, not 10. Codex-auth
is **23** `(method, path)` pairs over 20 literal guards, not 22.

## A3 — the lab exemption is wrong and makes accept criterion 2 unsatisfiable (blocking)

`020` exempts "20 `/api/lab/*` reads" under `local-transport`, on the grounds that
`ocx lab` reads the same data from local SQLite. The premise is sound —
`src/cli/lab.ts` imports `../lab/query` directly and never fetches `/api/lab` — but the
set is wrong in a way that matters.

The family is **21 routes: 14 GET and 7 mutating.** The mutating seven, verified:

```
lab-routes.ts:296  POST /api/lab/public/preview
lab-routes.ts:309  POST /api/lab/public/export
lab-routes.ts:322  POST /api/lab/public/verify
lab-routes.ts:336  POST /api/lab/public/community/import
lab-automation-routes.ts:119  POST /api/lab/automation/run
lab-automation-routes.ts:163  PUT  /api/lab/automation
lab-automation-routes.ts:106  POST /api/lab/automation/runs/{id}/cancel   (regex)
```

A local SQLite read cannot start an automation run or import a community bundle, so
`local-transport` does not cover any of these seven. As written, seven existing routes
have no verb and no valid exemption, so accept criterion 2 — "a new route with no verb
and no exemption fails the parity test" — is violated on day one. The gate must be
born red or widened at birth, and widening it at birth is precisely the silent erosion
`020` says the mandatory reason string exists to prevent.

**Amendment.** Split the row:

- **11** lab reads are `local-transport`-exempt (8 literals at `lab-routes.ts:354,358,370,385,411,441,471,516` plus 3 regex at `:424,499,545`).
- **3** further GETs (`/api/lab/public/community`, `/api/lab/automation`, `/api/lab/automation/runs`) are exempt only if the doc says so explicitly. Decision: include them, reason `local-transport`.
- **The 7 mutating routes get real verbs in wp7**, not an exemption. wp3 declares them with `exempt: { reason: "deferred-verb", owner: "wp7" }` — a *bounded* exemption naming the phase that retires it, so the gate stays honest and the debt stays visible rather than absorbed.

Introducing `deferred-verb` is a real widening of the exemption vocabulary, so it is
constrained: it requires an `owner` field naming a work-phase, and
`tests/cli-api-parity.test.ts` asserts every `deferred-verb` owner is a phase that
still exists in the goalplan. An exemption that outlives its owner fails the build.

## A4 — the version-skew edit targets a function that cannot carry a value (blocking)

`020.4` says to populate `version` "in the probe that already parsed and validated the
healthz body (`isOpencodexHealthz`)". That function is a pure predicate:

```ts
export function isOpencodexHealthz(body: HealthzIdentity | null): boolean
```

It receives the body and returns a boolean. The parsed body lives one frame up in
`proxyIdentityAt`, whose signature discards everything but the pid:

```ts
): Promise<{ pid: number | null } | null> {
  …
  return { pid };
```

**Amendment.** The edit is three hops, not one: widen `proxyIdentityAt`'s return type
to carry `version?: string` (guarded by `typeof === "string"`, mirroring the existing
pid guard), thread it through all three `findLiveProxy` construction sites, then add
the `LiveProxy` field. `020.4`'s "no extra request" conclusion still holds — the body
is already parsed — but for a different reason than it states.

### A4.1 — 12 exhaustive assertions break, and the doc does not list the file

`tests/proxy-liveness.test.ts` appears nowhere in `020`'s file list or test table. It
holds 9 `expect(live).toEqual(…)` and 3 `expect(identity).toEqual(…)` assertions
(counts reproduced directly). Bun's `toEqual` rejects an extra **defined** key while
tolerating an `undefined` one, so every assertion whose mock body carries a version
string fails the moment the field is threaded through. Add the file to the amended test
table as MODIFIED.

### A4.2 — the warning has no semantic home

`020.4` says to "push" the warning into the warnings array. There is no
general-purpose warnings array. The only candidate is `warningParts` at `status.ts:238`,
which is joined into `codexRuntime.warning` and printed under the Codex-runtime
heading. A stale-`ocx`-on-PATH warning is not a Codex-runtime fact.

**Amendment.** Add a dedicated top-level `versionSkew` object to `CliStatusJson` (type
at `status.ts:23`, construction literal at `status.ts:312`) plus a printer edit in
`src/cli/index.ts` near `handleStatus`. Without the printer edit the warning is
invisible in non-JSON `ocx status`, which defeats accept criterion 4 while appearing to
satisfy it.

Two fallbacks must suppress the warning rather than report skew against a placeholder:
server-side `VERSION` falls back to `"0.0.0"`, and `packageVersion()` returns
`"unknown"`. `schemaVersion` stays `1`: additive optional fields do not break the
contract, and `tests/cli-status-json.test.ts:88` pins it.

## A5 — 020.2 is a contract change, not a deletion sweep (blocking)

`020`'s opening line — "20 module `USAGE` constants with zero consumers outside their
own files" — conflates three different quantities. The truth:

- **20** is the *file* count.
- **37** usage constants are declared across those files.
- **12** are exported (count reproduced directly).
- The 12 exports are one-line **aliases** at file bottoms (`export const ACCESS_USAGE = USAGE;`). Those alias statements are dead.
- The constants they alias are **heavily live**: 243 non-declaration references inside their own files.

The live consumers are not incidental. They are the second argument to a contract:

```ts
export class CliUsageError extends Error {
  constructor(message: string, readonly usage?: string) {
export function rejectArgs(args: string[], usage: string, options?: RejectArgsOptions): void {
```

So "delete the module-level `USAGE` constant and have the usage path call
`printSubcommandUsage`" is not mechanical. It changes what `CliUsageError.usage`
carries across hundreds of call sites, and `CliUsageError` is how the CLI reports
argument errors — the surface these very issues are about.

**Amendment.** wp3 deletes the **12 dead alias exports** and re-sources usage *text*
from the capability table, leaving `rejectArgs(args, USAGE)` call sites structurally
intact: each module's `const USAGE` becomes a lookup into the capability table rather
than a literal. Same identifier, same call sites, generated content. The four
`ACCOUNT_USAGE` sites keep `console.error` + `return 1` exactly as `020` already
preferred.

## A6 — "exactly the visible capability set" is unsatisfiable as stated

The banner carries `help` and `--version`, and `CLI_COMMANDS` has an entry for neither,
though both are real dispatch runners. It also carries subcommand lines (`ocx restore
back`, `ocx doctor --reclaim-response-temps`, `ocx claude desktop`) that are not
registry entries.

**Amendment.** Add `help` and `--version` capability entries, and declare a
`bannerLines` field so a capability can contribute more than one banner row. Then
"exactly" is checkable. Without this, accept criterion 1 ("no hand-maintained command
list remains") is not reachable.

## A7 — 020.3's registration constraints, stated

A literal reading of "register in `dispatch.ts` and `registry.ts`" fails the existing
parity assertions. The binding constraints:

1. `CLI_COMMANDS` entry needs `name`, `usage`, `summary` (all required).
2. No `hidden: true` — the hidden set is pinned to exactly six `__`-prefixed names.
3. A `capabilities:` key in `commandRunners` returning `Promise<number>`.
4. No aliases unless a matching own-name entry exists.
5. **Ordering: 020.1 lands before 020.3.** The banner test greps `help.ts` source text,
   so a registry entry added before the banner is generated requires a hand-edit that
   020.1 then deletes. `020` states no ordering; this amendment fixes it.

## A8 — the `src/lab/` boundary risk `020` never mentions

`020` does not address the Lab boundary at all, and the protected set is **four** files,
not three: `tests/core-lab-boundary.test.ts` includes `src/server/management-api.ts` —
which statically imports every `src/server/management/` handler, making it the natural
importer of a new `route-registry.ts`. If that registry reaches `src/lab/`, the guard
fails.

**Mechanism, verified against the guard's own source.** The registry holds only inert
data — `{ method, path, module, auth, mutates, exempt? }`. Three specifics make it safe:

- Path strings are data. `"/api/lab/status"` in a string literal creates no module edge; the walker follows only `import`/`export … from` and direct `import()`.
- Any Lab-adjacent type comes in via `import type`, which the guard's regex excludes with a negative lookahead on every alternative.
- The `module` field names the *handler module* (`"./management/lab-routes"`), which the guard deliberately does not treat as naming Lab. Existing lazy dispatch at `management-api.ts:126,129` stays untouched: the registry describes those routes, it must never resolve their handlers.

Verify with `bun test tests/core-lab-boundary.test.ts`, which prints the offending
chain on failure, rather than by inspection.

## A9 — unreproducible headline numbers

`001`'s "183 reachable routes / 108 mutating / 19 files" records no counting method and
no command. An independent enumeration produced 206/116/21. Neither was adjudicated,
and that is the point: **an unreproducible number has no place in the phase whose
entire purpose is preventing a vacuous gate.**

**Amendment.** `001` is annotated to mark the figures unsourced. wp3 does not depend on
them — the registry is *declared*, and once it exists it becomes the count, with the
reconciliation test as its proof. Accept criteria are restated against the registry
rather than against any prior number.

## Amended test table

| File | State | Assertion |
|---|---|---|
| `tests/management-route-registry.test.ts` | NEW | three checks: scan→registry, registry→source, per-module `(method,path)` reconciliation with fail-loud method resolution |
| `tests/cli-api-parity.test.ts` | NEW | every route has a capability or a reasoned exemption; every `deferred-verb` owner is a live goalplan phase |
| `tests/cli-capabilities.test.ts` | NEW | `--json` shape stable; `--route` filter resolves |
| `tests/cli-registry.test.ts` | MODIFIED | generated banner equals the visible capability set incl. `help`/`--version`/`bannerLines` |
| `tests/proxy-liveness.test.ts` | **MODIFIED (was missing)** | 12 `toEqual` assertions carry `version` |
| `tests/cli-status-json.test.ts` | MODIFIED | `versionSkew` present; `schemaVersion` stays 1; stderr stays empty under `--json` |
| `tests/doctor.test.ts` | MODIFIED | skew section emitted (exists: 763 lines, drives `runDoctor`) |
| `tests/core-lab-boundary.test.ts` | UNCHANGED, must stay green | the registry reaches no `src/lab/` module |

## Amended accept criteria

1. `ocx --help` is generated; no hand-maintained command list remains.
2. A new route with no capability and no reasoned exemption fails `tests/cli-api-parity.test.ts` — and the gate is **green on day one**, because the 7 mutating lab routes carry bounded `deferred-verb` exemptions owned by wp7.
3. `ocx capabilities --json` enumerates the surface with routes and flags.
4. `ocx status` warns on skew in **both** human and JSON output, and suppresses the warning when either side reports a placeholder version.
5. The reconciliation test fails on a route added by any of the mechanisms in A2's table, proven by adding one and observing red before removing it.

Criterion 5 replaces a claim with a demonstration. Given that `020`'s original gate
would have failed on correct code while believing itself rigorous, a gate that has not
been driven red is not yet evidence of anything.

## A10 — self-audit: four defects in this amendment

The A-gate audit of this document was attempted twice with an adversarial reviewer and
both attempts died on provider rate limits (`429`), so the audit was performed directly
instead. Recording that substitution honestly matters: an unaudited amendment claiming
to fix an unaudited plan is the same failure one level up.

Four defects were found in the amendment itself. Two are blocking.

### A10.1 — A1's method resolution looks the wrong direction (blocking)

A1 says resolve the method "from the same line, else the two following lines, else the
enclosing block." In `lab-routes.ts` the method is fixed by a **preceding early-return
guard**, not an enclosing block:

```ts
  if (req.method !== "GET") return null;      // lab-routes.ts:352

  if (url.pathname === "/api/lab/status") {   // :354 — GET, decided 2 lines earlier
```

`storage-log-guard-routes.ts` inverts it again — the path is outer and the method is
the **inner** early return:

```ts
  if (url.pathname === "/api/storage/codex-logs") {   // :112
    if (req.method !== "GET") return null;            // :113
```

So three distinct shapes carry a method: same-line conjunction, a preceding sibling
guard that narrows everything after it, and a nested guard inside the path block. A
scanner that only looks forward and outward resolves none of the 8 lab reads.

**Fix.** Resolve the method by walking the enclosing function's statements in order and
maintaining a *method narrowing context*: a top-level `if (req.method !== X) return`
narrows every subsequent sibling statement to X; a nested one narrows only its own
block; a same-line conjunction binds only that route. This is a small interpreter over
guard statements, not a regex, and A1 must say so — the honest cost of the fail-loud
requirement is that the scanner cannot be a one-line `rg`.

### A10.2 — A3's `owner` assertion cannot run in CI (blocking)

A3 has `tests/cli-api-parity.test.ts` assert that every `deferred-verb` owner "is a
phase that still exists in the goalplan." The goalplan is machine-local and
**gitignored**:

```
$ rg -n 'codexclaw' .gitignore
45:.codexclaw/
46:**/.codexclaw/
$ git ls-files .codexclaw      # empty
```

`tests/repo-hygiene.test.ts` additionally forbids tracking it. A test reading that file
passes on this machine and cannot even find it in CI, which is the same class of
vacuous gate this amendment exists to eliminate — and it would have been introduced by
the fix, not the original.

**Fix.** Bind the exemption to a **tracked** artifact instead. `deferred-verb` carries
`owner: "wp7"` plus `ownerDoc: "devlog/_plan/260828_ocx_agentic_control/060_phase_gui_parity.md"`,
and the test asserts the doc exists and names the route. `devlog/` is tracked ordinary
markdown, so the assertion means the same thing in CI as locally. The debt stays
visible in the repository rather than in one developer's state directory.

### A10.3 — A5's lookup can silently produce empty usage text (major)

A5 has each module's `const USAGE` become a lookup into the capability table. Those
constants are **top-level**, evaluated at import time (`access.ts:12` and its 19
siblings). ESM tolerates a top-level cycle by yielding `undefined` rather than
throwing, so if the capability table ever imports a module that imports it back, every
`rejectArgs(args, USAGE)` in that module quietly starts reporting empty usage — a
silent regression in exactly the error-reporting surface these issues are about.

Today the direction is clean (`help.ts` imports only `./registry`; nothing imports
`access.ts`, `combo.ts`, or `observe.ts`), so the cycle is a risk introduced by the
change, not a present defect.

**Fix.** `src/cli/capabilities.ts` imports **nothing** from `src/cli/` — it is a leaf
data module, same discipline A8 imposes on the route registry. Add a guard test
asserting `capabilities.ts` has no `./`-relative import into a command module, and
assert each generated `USAGE` is a non-empty string so an accidental cycle fails loudly
instead of degrading.

### A10.4 — A6's `--version` entry is wrong; `help` is deliberately excluded (major)

A6 proposes capability entries for `help` and `--version`. Both are mis-specified.

`--version`, `-v`, and `version` never reach the dispatch table at all. They are
resolved in the CLI head (`root.ts:28`) and exit before dispatch, so `--version` has no
runner key and an entry named `--version` would fail the assertion that every canonical
entry is a direct runner key.

`help` is not an oversight either. `tests/cli-registry.test.ts:14-21` documents the
exclusion in a comment and encodes it in a `headHandled` set — `help`/`--help`/`-h` are
"head-handled pseudo-cases, not commands." A6 read a deliberate decision as a gap.

**Fix.** Neither becomes a `CLI_COMMANDS` entry. The capability table gains a separate
`headCapabilities` list for head-handled surfaces, which contributes banner lines and
`ocx capabilities --json` output without touching runner-key parity. The banner
equality assertion then compares against `visible capabilities + headCapabilities`,
which is satisfiable — A6's version was not.

### Confirmed correct in A2

`agent-settings-routes.ts` and `oauth-account-routes.ts` are rightly absent from the
18-route table. Their `startsWith`/`slice` hits are payload manipulation
(`oauth-account-routes.ts:584` truncates a key prefix; `agent-settings-routes.ts:900`
filters model routes), not path guards. The omission was checked rather than assumed.
