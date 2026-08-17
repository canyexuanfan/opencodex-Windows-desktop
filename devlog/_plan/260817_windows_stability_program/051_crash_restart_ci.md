# 051 — Windows crash-restart coverage in service CI (F7)

**Depends on:** 050 — test the behavior after it is worth testing.

## Change

`.github/workflows/service-lifecycle.yml` has a `windows-schtasks` job at line
239 covering install, health, clean `ocx stop`, uninstall. The Linux job at
lines 104-135 does more: it kills the systemd MainPID, waits for a *different*
PID, and asserts `/healthz` recovers.

Add the Windows equivalent: kill the proxy process the scheduled task launched,
wait for the wrapper to relaunch it, assert a new PID and a healthy `/healthz`.

With 050 landed, the first retry is still 5s, so the test does not need to wait
out the backoff curve. Give it margin anyway — hosted Windows runners are slow
and a tight bound here becomes the flake this unit is trying to prevent.

## Verify

The workflow is the verification. Run it on a branch, confirm it passes, then
confirm it *fails* when 050's backoff is reverted to a broken loop.

## Risk

Medium — this is new CI on the platform we are about to make required (060).
A flaky crash-restart test would poison that gate. Land it, watch it across
several runs, and only then let 060 depend on it.
