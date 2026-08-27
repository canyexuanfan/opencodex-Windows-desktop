# 011 — wp2 implementation record

Branch `codex/ocx-transport-honesty`. Implements `010` (#2697, #2698, #2696).

## What landed

| File | Change |
|---|---|
| `src/cli/dispatch.ts` | `provider` and `models` runners return `Number(process.exitCode ?? 0)` instead of a literal 0 (#2697) |
| `src/cli/runtime-api.ts` | `responseMessage` composes primary + `reason:` + `hint:`, capped at 1200 chars (#2698) |
| `src/cli/account-api.ts` | `ApiResult.transportError` retains the cause behind the status-0 sentinel; `apiError` renders `reason`/`hint` and maps 404→4, 409→5; `proxyUnreachable` accepts the cause |
| `src/service.ts` | `assertNotAdminToken` refuses an `ocx_admin_` value as the data-plane secret, called from both `writeServiceApiTokenFile` and `assertServiceAuthEnvironment` before the loopback short-circuit (#2696) |
| `src/cli/doctor.ts` | `dataPlaneCredentialCollisionCheck` names an already-broken install and its remedy without echoing the credential |
| `tests/cli-transport-honesty.test.ts` | 16 tests, new file |

`apiError` gained an optional third parameter, so all existing call sites keep
compiling and their current exit code.

## The guard found a real error in its own plan

`010` specified an allowlist of `["login", "logout", "tray"]` for runners allowed to
return a literal 0. That was a guess, and the guard contradicted it: the actual
offenders are `debug` and `login`, and `logout`/`tray` do not match the pattern at all.

Both are allowlisted on a verified basis rather than an assumed one:
`handleDebugCommand` and `handleLogin` report every failure with `process.exit(1)`
from inside the handler (debug.ts does so on 11 paths), so control reaches `return 0`
only on success.

That is a narrower claim than "these commands cannot fail". `login` reporting success
for a failed OAuth flow is a real gap — it belongs to wp3b's uniform exit-code
contract (`025`), not to this phase's management-transport scope. Recorded rather than
silently absorbed.

The `[^;]*` form was also necessary, not stylistic: the `[^)]*` form `010` originally
proposed matches neither target runner, and the red-first assertion in the test exists
so that can never regress unnoticed.

## Verification

- `tsc --noEmit`: clean. Proven non-vacuous by injecting a type error into
  `account-api.ts`, observing `TS2322` at the exact line, then restoring and
  re-confirming clean.
- `bun test tests/cli-transport-honesty.test.ts`: 16 pass.
- `bun test` over `cli-dispatch`, `cli-management-auth`, `cli-account`, `service`,
  `cli-registry`, `cli-headless-parity`: 297 pass.

## One unexplained failure, recorded rather than dismissed

The first run of that six-file batch reported 296 pass / 1 fail — the
`vision --list` case in `cli-headless-parity`. The same batch on a pristine
`origin/dev` worktree gave 297/0, so the initial reading was that this diff caused it.

It did not reproduce in 26 subsequent runs, including the same batch on this branch.
The test passes in isolation.

Most plausible mechanism, stated as a hypothesis and not a conclusion:
`fakeRuntime` starts a real `Bun.serve` per test, and files run in parallel, so a
port-level collision would return another fake's payload — which is exactly the shape
of the failure (a missing `visionModels` entry rather than a wrong assertion). Nothing
in this diff touches that harness or `handleAgentCommand`.

Not claimed as fixed and not dismissed as flaky. If it recurs in wp9's CI, the first
thing to check is the harness's port allocation, not this phase's changes.

