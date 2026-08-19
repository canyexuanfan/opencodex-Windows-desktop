# Phase 1 — periodic reclaim via the state-store sweeper

## Thesis

Abandoned response-state temps are reclaimed on a timer, so a proxy that never serves
a continuation request still cleans up after a previous crash.

Amended after audit round 1 (`001_audit_round1.md`): the timer alone does not reclaim
the reported files, because a reused pid makes the liveness skip permanent. This layer
therefore ships the boot-time floor with it.

## Why the sweeper is the right owner

`src/lib/state-store-sweeper.ts` already runs every 60 s (`STATE_SWEEP_INTERVAL_MS`),
is started once per process from `startProcessLoops` in
`src/server/background-lifecycle.ts:59`, is `unref`'d so it cannot hold the process
open, and wraps every callback in try/catch with `logCallbackFailure`. The
`responses-continuation` store is ALREADY registered there
(`src/lib/state-store-registrations.ts:87`) for TTL eviction. Disk reclaim for the
same subsystem belongs on the same tick.

`sweepExpired` is the wrong slot: it is called by `sweepExpiredOnWrite`
(`state-store-sweeper.ts:91`) on write paths, and filesystem scans do not belong on a
write. `sweepLiveness` is the correct slot — it runs only on the interval tick
(`:162`), and "is the process that owns this temp still alive" is precisely a
liveness question.

## Change map

### MODIFY `src/responses/state.ts` — boot-time floor (audit blocker 1)

`recoverStaleResponseStateTemps` skips a temp whose pid is alive (`:582`). The 15-minute
gate at `:581` is a LOWER bound and never expires that skip, so a pid reused after a
reboot strands the file forever. A temp whose `mtimeMs` predates system boot cannot
belong to any live pid, so the liveness probe is provably vacuous for it.

Add `bootTime: () => number` to `ResponseStateTempRecoveryIO` (default
`() => Date.now() - os.uptime() * 1000`) and reclaim when the file predates boot, in
ADDITION to the existing gates:

```diff
-    if (pid === process.pid || io.isProcessAlive(pid)) continue;
+    // A temp written before the current boot cannot belong to any live pid: after a
+    // reboot the original writer's pid is routinely reused, which would otherwise make
+    // the liveness skip permanent (the 15-minute gate is a lower bound, so it never
+    // expires it). Every other guard still applies.
+    const predatesBoot = file.mtimeMs < io.bootTime() - BOOT_FLOOR_SKEW_MS;
+    if (!predatesBoot && (pid === process.pid || io.isProcessAlive(pid))) continue;
+    if (predatesBoot && pid === process.pid) continue;
```

`BOOT_FLOOR_SKEW_MS = 60_000` absorbs clock skew and `os.uptime()` granularity. The
`pid === process.pid` guard is kept unconditionally: this process is by definition
younger than boot, and must never unlink its own in-flight temp.

### MODIFY `src/responses/state.ts` — shared directory resolution (audit blocker 3)

The literal + symlink-resolved pair is computed inside `ensureLoaded` (`:604-625`). A
callback sweeping only `getConfigDir()` would miss temps stranded in a symlinked
snapshot's real directory. Extract it once and use it from BOTH callers:

```ts
/** Literal config dir plus the snapshot's resolved dir; identical when nothing is symlinked. */
function responseStateSweepDirectories(): Set<string> {
  const path = snapshotPath();
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  return new Set([dirname(path), resolvedDir]);
}
```

### MODIFY `src/responses/state.ts`

Add an exported wrapper next to `sweepExpiredResponseStates` (after line 899). It
resolves the same two directories `ensureLoaded` sweeps (literal + symlink-resolved),
and returns a removed count so the sweeper's `rowsRemoved` accounting stays truthful.

It MUST be synchronous (audit blocker 2): `runCallbacks` discards a returned promise,
so an `async` reclaim would swallow every error and defeat its `try/catch`. It also
passes a smaller per-tick budget than the startup path — 4096 entries is a startup-scale
budget, and a synchronous scan blocks the event loop. Reclaim is idempotent and repeats
every 60 s, so a smaller budget costs nothing.

```ts
/** Per-tick budget. Smaller than the startup budget: this runs every 60 s, synchronously,
 *  on the event loop, and any remainder is reclaimed by the next tick. */
const PERIODIC_TEMP_MAX_ENTRIES = 512;
const PERIODIC_TEMP_MAX_CLEANUPS = 64;

/**
 * Periodic disk reclaim for abandoned atomic-write temps. `ensureLoaded` sweeps once on
 * first continuation access, which never happens in the case that produces the garbage:
 * a proxy that crashes before serving a continuation request leaves its temp behind and
 * never reaches that path. Registered on the sweeper's liveness tick so reclaim does not
 * depend on serving traffic.
 */
export function sweepAbandonedResponseStateTemps(): number {
  let removed = 0;
  for (const dir of responseStateSweepDirectories()) {
    try {
      removed += recoverStaleResponseStateTemps(dir, {
        maxEntries: PERIODIC_TEMP_MAX_ENTRIES,
        maxCleanups: PERIODIC_TEMP_MAX_CLEANUPS,
      }).removed;
    } catch {
      /* best-effort: disk reclaim must never destabilize the sweeper tick */
    }
  }
  return removed;
}
```

New import: `uptime` from `node:os` for the boot floor. `dirname`, `resolveWriteTarget`,
and `recoverStaleResponseStateTemps` are already in scope.

### MODIFY `src/lib/state-store-registrations.ts`

Line 37 — extend the existing import:

```diff
-import { sweepExpiredResponseStates } from "../responses/state";
+import { sweepAbandonedResponseStateTemps, sweepExpiredResponseStates } from "../responses/state";
```

Line 87 — extend the existing registration rather than adding a second store, so one
subsystem keeps one row:

```diff
-  { name: "responses-continuation", sweepExpired: sweepExpiredResponseStates },
+  {
+    name: "responses-continuation",
+    sweepExpired: sweepExpiredResponseStates,
+    sweepLiveness: sweepAbandonedResponseStateTemps,
+  },
```

### MODIFY `tests/responses-state.test.ts`

Add a regression test asserting the reclaim runs without any continuation access —
the exact property that was missing. It must prove the negative: a stale temp is
removed while a live-PID temp and a young temp survive, with `ensureLoaded` never
driven.

## Scope boundary

IN: the wrapper, the registration, the test.

OUT: any change to `recoverStaleResponseStateTemps` itself — its age gate, PID check,
file-type check, and bounds are already correct and independently tested
(`tests/responses-state.test.ts:1522`, `:1575`). Touching them would widen the blast
radius of a scheduling fix into a safety-critical one.

OUT: startup one-shot reclaim. The first tick lands 60 s after start, which is
adequate for a defect measured in months of accumulation, and adding a startup call
would put a filesystem scan on the boot path.

## Accept criteria

| # | Scenario | Observable proof |
|---|----------|------------------|
| 1 | Sweeper tick with no continuation traffic | stale temp gone; `ensureLoaded` never invoked |
| 2 | Temp owned by a live PID | survives the tick |
| 3 | Temp younger than the 15-minute grace | survives the tick |
| 4 | Reclaim throws (unreadable dir) | tick completes; other stores still swept |
| 5 | Temp predating boot whose pid is now LIVE (reuse) | reclaimed — the permanent-skip case |
| 6 | Temp predating boot owned by THIS process | survives; never unlink our own in-flight temp |
| 7 | Symlinked snapshot dir | temp in the resolved real dir is reclaimed |

Criterion 4 is the activation scenario for the new catch block
(C-ACTIVATION-GROUNDING-01): force `list` to throw and assert the tick still returns.
Criterion 5 is the activation scenario for the boot floor: without it the file is
skipped forever, so the test must fail if the floor is removed.

## Verification

`bun test tests/responses-state.test.ts`, then `bun run typecheck` and
`bun run test` before the PR is review-ready (shared runtime + registration table).
Also `bun test tests/state-store-sweeper.test.ts`: its "global fake-clock sweep"
assertion derives from `STATE_STORE_REGISTRATIONS`, so adding a `sweepLiveness` member
changes what that test expects.
