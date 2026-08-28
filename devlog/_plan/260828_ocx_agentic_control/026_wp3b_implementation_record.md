# 026 — wp3b implementation record

Branch `codex/ocx-uniform-contract` off `codex/ocx-capability-registry`. Implements `025`.

## What landed

| File | Change |
|---|---|
| `src/cli/doctor.ts` | per-pass failure flag + `doctorFailed()`; a `FAIL`-level OAuth check records a failure |
| `src/cli/dispatch.ts` | `doctor` returns 1 on failure; `restore` scans argv for `--json`; `sync-cache` returns 1 when the cache write did not complete and gained a `--json` envelope |
| `src/cli/index.ts` | `status` uses `takeFlag`, so `--json` works in any argv position |
| `tests/cli-json-contract.test.ts` | 8 tests, new file |

## The plan under-specified how `doctor` aggregates failures

`025` says "return non-zero when any check fails." That reads as though there were a
checks collection to inspect. There is not: the `checks.push` calls belong to
`collectOAuthDoctorChecks`, a different function, and `runDoctor` reports by direct
`console.log` across roughly a dozen sections with `ok `/`!! `/`[WARN]` prefixes.

So the failure signal is a module-scoped flag reset at the top of each `runDoctor` pass.
The reset is not incidental: the suite drives `runDoctor` several times in one process,
and a sticky flag would fail the second call because the first saw a problem — a test
that passes or fails depending on execution order, which is worse than no gate.

## Only `FAIL` fails the command

`025` does not distinguish the levels. It matters. `WARN` describes a
degraded-but-working install, and this doctor emits `[WARN]` freely — a Codex app-server
started before the catalog changed, a WHAM probe that could not reach chatgpt.com. Failing
on those would break pipelines that are legitimately green, and the predictable response
is that people stop running the gate. `FAIL` is documented in `doctor.ts:63` as the level
for a surface that is unusable rather than degraded, which is exactly the line worth
exiting non-zero on.

## `sync-cache` needed a success definition, not just an exit code

`invalidated.kind === "completed"` with a falsy value means the cache was **not**
rewritten, and any other kind means the write never completed. Both previously exited 0.
But a deliberate skip — Codex integration off — is not a failure, and treating it as one
would make `ocx sync-cache` fail on a correctly configured machine that simply is not
using Codex. Success is therefore `wrote || desiredDisabled`, and the `--json` envelope
reports `wrote` and `skipped` separately so a caller can tell which happened.

## The contract test generalises past the two known defects

Pinning only `status` and `restore` would leave the next command free to repeat the
mistake, so the test fails on **any** `args[<n>] === "--json"` in `dispatch.ts`,
`index.ts`, or `root.ts`. It also pins both defective forms as exact strings, so a revert
is caught by a failing test rather than discouraged by a comment.

## Verification

- `tsc --noEmit`: clean.
- 9 focused suites: 125 pass, 0 fail, 618 expect() calls.
- Non-vacuous: reverting the `restore` fix alone turned 3 of the 8 contract tests red.
- `ocx status --json` verified live; `ocx status --json --bogus` still rejects.

## Deferred, deliberately

`025.3` asks for `--json` on `login`, `logout`, `sync`, and `debug` as well. Those four
are interactive or long-running flows whose human output is not a single structured
result, and inventing an envelope for them without a consumer would be guesswork. They
move to wp7 alongside the GUI-parity verbs, where the shape is driven by an actual caller.
`doctor` and `sync-cache` are done here because both are already single-result commands
that a script wants to gate on.
