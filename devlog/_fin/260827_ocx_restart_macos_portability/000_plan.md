# Portable detached restart on macOS

## Loop specification

- Archetype: repair
- Trigger: `scripts/ocx-restart.sh` stops the active proxy and cannot relaunch it when `setsid` is unavailable.
- Goal: the helper relaunches the development proxy on macOS while preserving the existing `setsid` isolation path where that command exists.
- Non-goals: change service-manager semantics, change the proxy runtime, alter provider configuration, include the unrelated `package.json` edit, or publish a package release.
- Verifier: a focused Bun test executes the real shell script with a controlled command path that deliberately has no `setsid`; `bash -n` checks shell syntax; live launchd status and `/healthz` prove operational recovery.
- Stop condition: focused/full repository gates required by `scripts/AGENTS.md` pass, the exact scoped commit reaches `origin/dev`, and the repaired service answers on port 10100.
- Memory artifact: this document plus the commit and command receipts reported at completion.
- Expected terminal outcomes: DONE when code, push, and live recovery are proven; BLOCKED if current `origin/dev` moves incompatibly or launchd repair fails after the code fix.
- Escalation condition: return to diagnosis if the no-`setsid` path still fails or if `ocx service repair` cannot produce a loaded healthy service.

## Scope

### In

- `scripts/ocx-restart.sh`: select the existing `setsid` launch when available and a `nohup` fallback when it is not.
- `tests/install-scripts.test.ts`: execute the real helper in an isolated home with command shims and no `setsid`, asserting that both stop and start are reached and the helper reports healthy.
- This unit record, moved to `_fin/` after verification.

### Out

- `package.json` and every other pre-existing user change.
- `src/service.ts`, launchd plist generation, provider routing, and Codex configuration.
- Release, package publication, or branch cleanup.

## Diff-level plan

1. In `scripts/ocx-restart.sh`, replace the unconditional background launch with a capability check:
   - when `command -v setsid` succeeds, retain `setsid nohup bun ... &`;
   - otherwise run `nohup bun ... &` with the same stdin/stdout/stderr detachment;
   - keep the existing health loop and failure output unchanged.
2. In `tests/install-scripts.test.ts`, add a non-Windows behavior test that:
   - creates an isolated `HOME` and a `PATH` containing only required command shims, intentionally omitting `setsid`;
   - records fake Bun stop/start invocations, creates the runtime port and PID files on start, and makes the health probe succeed;
   - invokes the repository's real restart script and asserts exit 0, healthy output, and ordered stop/start calls.
3. Run the focused test, shell syntax check, typecheck, full test suite, and privacy scan. Inspect the staged diff to prove `package.json` is excluded.
4. Commit named paths only, refresh the remote lease, and push `dev` with `--force-with-lease --no-verify` as explicitly authorized.
5. Run `ocx service repair`, then verify a loaded service, a live PID/listener on 10100, HTTP 200 from `/healthz`, and healthy `ocx status`.

## Acceptance criteria

| Scenario | Activation | Observable proof |
| --- | --- | --- |
| `setsid` unavailable | Test `PATH` omits `setsid` while providing all other commands | Script exits 0, fake Bun log records stop then start, stdout reports healthy |
| `setsid` available | Static review preserves the existing branch and shell syntax remains valid | Diff retains `setsid nohup`; `bash -n scripts/ocx-restart.sh` exits 0 |
| Unrelated dirty work | `package.json` remains modified before and after commit | `git show --name-only` contains only the script, test, and unit record; working tree still shows `M package.json` |
| Live service recovery | Run `ocx service repair` after the pushed fix | launchd is loaded, 10100 has a listener, `/healthz` returns HTTP 200, status reports running |

## Verifier preflight

- `bun test tests/install-scripts.test.ts`: exit 0 with 9 passing tests before the change. It does not yet observe `scripts/ocx-restart.sh`; the planned behavior test makes it the focused verifier in B/C.
- `bash -n scripts/ocx-restart.sh`: exit 0 and directly reads the target script, proving syntax only.
- `bun run typecheck`, `bun run test`, and `bun run privacy:scan`: repository-defined gates; their post-change receipts are required by `scripts/AGENTS.md` before completion.

## Rollback

Revert the scoped commit and run `ocx service repair` from the restored `dev` source. The existing launchd plist and user configuration are not modified by the code patch.

## Build evidence

- RED: `bun test tests/install-scripts.test.ts` failed the new no-`setsid` case with exit 1 on the unconditional launch.
- GREEN: the same focused file passed 10 tests after the capability fallback; `bash -n scripts/ocx-restart.sh` and `git diff --check` also exited 0.
- Operator override: the manually started `bun run prepush` was interrupted on request. Typecheck and the GUI no-change gate completed before interruption, but the incomplete full suite is not claimed as passing.
- Delivery: direct `dev` push was rejected by the active PR-only ruleset, so PR #2735 merged the exact scoped commit with merge commit `056d2996bcc0121b54bcbc0f2abf4df25633e794`. Local `dev`, `origin/dev`, and `git ls-remote` matched that SHA afterward.
- Live recovery: `ocx service repair` exited 0; launchd reported `state = running`, PID 83423 owned `127.0.0.1:10100`, `/healthz` returned HTTP 200 with `status: ok`, and `/v1/models` returned HTTP 200.
- Terminal outcome: DONE. The unrelated `package.json` edit remains uncommitted and preserved.
