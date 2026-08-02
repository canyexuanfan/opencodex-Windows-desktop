# WP3 — The update worker must confirm serving, not trust `viable`

Closes D3 from `000_plan.md`. Depends on WP1 (stronger `stale`) and WP2
(install-time verification).

## Problem

`src/update/job.ts:778-792`:

```ts
if (serviceOk) {
  const viable = (io.serviceViableFn ?? isServiceViable)();
  if (viable) return;               // <-- cancels the direct-start fallback
  updateJob(job, {}, "Service reinstall exited 0 but the background service is not viable ...");
}
```

`viable` is a *static registration* predicate: `installed && running && !stale`,
where `running` is `launchctl list | grep` being non-empty. A crash-looping job
satisfies it. So the one recovery path built specifically so that "browser-dashboard
updates do not require a viable Background Service" is skipped in exactly the
case it exists for.

WP1 makes a failed `launchctl load` raise, and WP2 makes `service install` refuse
to claim success without a listener — so by the time WP3 runs, a non-zero
`runService` exit already covers the common case. WP3 closes the remaining hole:
the worker must stop treating a *static registration predicate* as proof of
recovery. The only thing that proves recovery is a listener answering on the
captured port.

## MODIFY `src/update/job.ts`

### 1. Replace the early return with a health-gated one

```diff
       if (serviceOk) {
-        // Exit 0 is not enough: a reinstall can leave stale/missing assets (or a
-        // disabled/conflicting manager) that never brings /healthz back. Fall through
-        // to a direct start so browser-dashboard updates do not require a viable
-        // Background Service for recovery.
-        const viable = (io.serviceViableFn ?? isServiceViable)();
-        if (viable) return;
-        updateJob(
-          job,
-          {},
-          "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
-        );
+        // Exit 0 is not enough, and neither is `viable`. Registration state cannot
+        // distinguish a serving supervisor from one re-exec'ing a broken command
+        // every few seconds — `launchctl list` reports both. The 2026-08-02 report
+        // is exactly that: reinstall exited 0, viable was true, nothing listened,
+        // and this early return skipped the direct-start fallback built for it.
+        // Ask the port, not the registry.
+        const viable = (io.serviceViableFn ?? isServiceViable)();
+        if (viable) {
+          const serving = await serviceRestartServed(job, port, hostname, io);
+          if (serving) return;
+          updateJob(
+            job,
+            {},
+            `Service reinstall exited 0 and reported viable, but nothing answered on ${hostname}:${port} `
+            + `within ${Math.trunc(SERVICE_RECOVERY_HEALTH_MS / 1000)}s; falling back to a direct proxy start.`,
+          );
+        } else {
+          updateJob(
+            job,
+            {},
+            "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
+          );
+        }
       }
```

### 2. The new helper

Insert above `restartAfterUpdate` (near `src/update/job.ts:670`):

```ts
/** Health window for a service-managed restart before falling back to a direct start. */
export const SERVICE_RECOVERY_HEALTH_MS = 25_000;

/**
 * Whether the reinstalled service actually produced a listener on the captured
 * target. Deliberately shorter than RESTART_HEALTH_TIMEOUT_MS: this is not the
 * final verdict, only the decision of whether to also try a direct start. Being
 * wrong here costs one extra start attempt; being wrong the other way leaves the
 * user with no proxy at all.
 */
async function serviceRestartServed(
  job: UpdateJobState,
  port: number,
  hostname: string,
  io: RestartIo = {},
): Promise<boolean> {
  const probe = io.probeProxy ?? (async (p: number, h?: string) => (
    !!(await proxyIdentityAt(p, { hostname: h }))
  ));
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = io.now ?? (() => Date.now());
  // NOT io.healthTimeoutMs: that field is the final /healthz appearance window
  // consumed by awaitRestartedProxyHealthy (src/update/job.ts:1022). Overloading it
  // would couple "should we also try a direct start?" to "did the update succeed?",
  // so a test tightening one would silently retune the other.
  const deadline = now() + (io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Service-managed proxy answered on ${hostname}:${port}.`);
      return true;
    }
    if (now() >= deadline) return false;
    await sleep(500);
  }
}
```

Add the new field to `RestartIo` (`src/update/job.ts:624-669`), next to the
existing `healthTimeoutMs` and with a comment distinguishing the two:

```diff
   /** Override the /healthz appearance window (default {@link RESTART_HEALTH_TIMEOUT_MS}). */
   healthTimeoutMs?: number;
+  /**
+   * Override the window for deciding whether a service-managed restart served
+   * (default {@link SERVICE_RECOVERY_HEALTH_MS}). Distinct from healthTimeoutMs:
+   * this one only chooses whether to ALSO attempt a direct start.
+   */
+  serviceHealthTimeoutMs?: number;
```

### 3. Make the reinstall-failure message actionable

The worker runs `ocx service install` in a child process. After WP1,
`installLaunchd()` throws when the load did not take, so that child exits non-zero
and the existing `serviceOk = result.status === 0` branch already handles it — no
new guard is needed here. (R1 attributed this to an `assertBakedRuntimeRunnable`
helper; that helper belonged to the retracted stub narrative and does not exist.
WP1's throw is the real source of the non-zero exit.)

What is still wrong is the message:

```diff
         if (!serviceOk) {
-          updateJob(job, {}, `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start. Run 'ocx service install' as administrator to refresh the background service manager.`);
+          updateJob(
+            job,
+            {},
+            `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start.`
+            + (process.platform === "win32"
+              ? " Run 'ocx service install' as administrator to refresh the background service manager."
+              : " Run 'ocx service install' by hand to see the reason, then 'ocx service status'."),
+          );
         }
```

The "as administrator" advice is Windows-specific and is noise on macOS/Linux,
where the failure is almost always a bad baked path rather than elevation.

## MODIFY `tests/update-job.test.ts`

Clock convention: the file uses a local `let now = 0` with
`sleepMs: async ms => { now += ms; }` (`tests/update-job.test.ts:436`, `:463`,
`:492`). There is no `advancingClock()` helper in `tests/` — do not invent one.

```ts
describe("restartAfterUpdate — service recovery is health-gated", () => {
  // The regression: viable=true, service registered, nothing listening.
  it("falls through to a direct start when a viable service never serves", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => true,          // registration says healthy
      runService: () => ({ status: 0 }),    // reinstall exits 0
      probeProxy: async () => false,        // ...but nothing answers
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
      serviceHealthTimeoutMs: 1_000,
    });
    expect(spawned).toEqual([captured.port]);
  });

  it("returns without a direct start when the service does serve", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => true,
      runService: () => ({ status: 0 }),
      probeProxy: async () => true,
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
    });
    expect(spawned).toEqual([]);
  });

  it("still falls back when the service is not viable at all", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => false,
      runService: () => ({ status: 0 }),
      probeProxy: async () => false,
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
    });
    expect(spawned).toEqual([captured.port]);
  });
});
```

`spawnStart` is recorded as an array rather than a `mock()` to match the existing
style in this file (`tests/update-job.test.ts:153`, `:248`, `:278`).

### Existing seam — verified, no new export needed

`restartAfterUpdateForTests` already exists and is imported at
`tests/update-job.test.ts:12`, and `serviceViableFn` is already injectable
(used at `:308`, `:349`, `:386`). No visibility changes are required.

### Pre-existing test that this change WILL break

`tests/update-job.test.ts:306-325` ("bakes the captured port for the service
reinstall") drives `serviceInstalledFn: () => true` + `serviceViableFn: () => true`
+ `runService: () => ({ status: 0 })` and supplies **no** `probeProxy`. Under the
current code it returns at the `viable` early return; under WP3 it will fall into
`serviceRestartServed`, whose default probe performs a real `proxyIdentityAt`
network call against port 18765 and then burns the full
`SERVICE_RECOVERY_HEALTH_MS` before falling through to a direct start.

That test asserts `waited` and `bakeDuringInstall`, both of which still hold — but
it would gain a ~25s wall-clock cost and an unstubbed socket probe. Fix it in the
same commit by adding `probeProxy: async () => true` (the intent of that test is
the `OCX_BAKE_PORT` lifecycle, not the recovery decision) and note the change in
the B attest. Do not weaken `SERVICE_RECOVERY_HEALTH_MS` to make a test fast —
inject the probe.

Check the two sibling cases at `:347` and `:383` as well: both pass
`serviceViableFn: () => false`, so they take the unchanged branch and should stay
green without edits. Confirm that by running the file rather than by reading it.

### Red-first proof

Run the first test against unmodified `job.ts`: `spawnStart` is called 0 times
because the `viable` early return fires. Record that failure in the B attest.

## Verification

```
bun x tsc --noEmit
bun test tests/update-job.test.ts tests/update-stop-first.test.ts tests/service.test.ts
bun run test
```

## Done when

- A viable-but-silent service no longer cancels the direct-start fallback.
- A genuinely serving service still returns early (no redundant second proxy).
- Non-Windows reinstall failures stop advising `as administrator`.
