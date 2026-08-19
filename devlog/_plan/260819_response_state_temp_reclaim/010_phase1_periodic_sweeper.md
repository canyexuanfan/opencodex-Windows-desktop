# Phase 1 — periodic reclaim via the state-store sweeper

## Thesis

Abandoned response-state temps are reclaimed on a timer, so a proxy that never serves
a continuation request still cleans up after a previous crash.

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

### MODIFY `src/responses/state.ts`

Add an exported wrapper next to `sweepExpiredResponseStates` (after line 899). It
resolves the same two directories `ensureLoaded` sweeps (literal + symlink-resolved),
and returns a removed count so the sweeper's `rowsRemoved` accounting stays truthful.

```ts
/**
 * Periodic disk reclaim for abandoned atomic-write temps. `ensureLoaded` sweeps once on
 * first continuation access, which never happens in the case that produces the garbage:
 * a proxy that crashes before serving a continuation request leaves its temp behind and
 * never reaches that path. Registered on the sweeper's liveness tick so reclaim does not
 * depend on serving traffic.
 */
export function sweepAbandonedResponseStateTemps(): number {
  const path = snapshotPath();
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  let removed = 0;
  for (const dir of new Set([dirname(path), resolvedDir])) {
    try {
      removed += recoverStaleResponseStateTemps(dir).removed;
    } catch {
      /* best-effort: disk reclaim must never destabilize the sweeper tick */
    }
  }
  return removed;
}
```

No new imports: `dirname`, `resolveWriteTarget`, and `recoverStaleResponseStateTemps`
are all already in scope in this module.

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

Criterion 4 is the activation scenario for the new catch block
(C-ACTIVATION-GROUNDING-01): force `list` to throw and assert the tick still returns.

## Verification

`bun test tests/responses-state.test.ts`, then `bun run typecheck` and
`bun run test` before the PR is review-ready (shared runtime + registration table).
