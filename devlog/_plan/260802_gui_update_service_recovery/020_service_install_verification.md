# WP2 — `service install` must prove the service can serve

Closes D2 from `000_plan.md`. Depends on WP1's `runLaunchctl` /
`launchdJobMatchesPlist`.

## Problem

WP1 makes a failed load raise. That is necessary and not sufficient: a load can
*succeed* and still leave nothing listening — a bad `--port`, a config the proxy
rejects at startup, a runtime that execs and immediately exits. `installLaunchd()`
returns void either way, and `serviceCommand` prints

```
✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).
```

unconditionally at `src/service.ts:2082-2084` (inside `case "install":`, which
begins at `:2078`). That message is what the user acted on
when they re-ran `ocx service` and 10100 stayed silent.

`installSystemd()` has the same shape. Windows is excluded: its
`deriveWindowsServiceDiagnostic` already inspects registration health, and its
failure modes (UAC, schtasks XML) belong to a different unit.

## Design decision

**C1 — trust WP1's load verification.** Zero added latency, but blind to
"loaded fine, never served".

**C2 — poll `/healthz` on the baked port after load.** Directly asserts the thing
the user cares about.

**Chosen: C2, scoped to the baked port.** The waiting half is bounded and only
paid by `install`/`start`, which are slow hand-typed commands already. See the
budget note below for the one caller where that latency is not free.

## MODIFY `src/service.ts`

### Post-load health confirmation

New exported helper in `src/service.ts`:

```ts
export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * After load/enable, confirm the supervisor actually produced a listener on the
 * port this install just baked. Registration is not service: `launchctl list`
 * reports a job that never bound, which is how the 2026-08-02 dashboard update
 * ended with a green checkmark and a dead port.
 *
 * Probes the BAKED target, not the pidfile. `findLiveProxy()` resolves through
 * pidfile -> runtime-port -> config, and after a service reinstall the pidfile is
 * stale or absent by construction — so a service serving correctly on the baked
 * port would report unhealthy. Ask the port we just wrote into the plist.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark
 * and an actionable warning.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? resolveServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? SERVICE_INSTALL_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
    if (now() >= deadline) return { ok: false, port };
    await sleep(500);
  }
}
```

**Why not `findLiveProxy`** (the R1 design, rejected in audit): it is imported at
`src/service.ts:9` and the injection shape at `src/service.ts:486`
(`inspectWindowsSchedulerServiceStatus`) is the house style — but it resolves the
target through the pidfile, which a service reinstall has just invalidated. A
service serving on the baked port with a stale pidfile would report `ok: false`
and exit 1. `proxyIdentityAt` is the same identity-checked `/healthz` probe
without the resolution step; it is already imported in `src/update/job.ts:23` and
needs adding to `src/service.ts`.

`resolveServiceListenPort()` (`src/service.ts:317`) is the same function that
produced the port baked into the wrapper, so the probe and the plist cannot drift.

### Import diff (the phase's one new module edge)

`src/service.ts:9` currently imports only `findLiveProxy, SERVICE_STOP_LIVENESS`:

```diff
-import { findLiveProxy, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
+import { findLiveProxy, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
```

`proxyIdentityAt` is already exported from that module and already used the same
way in `src/update/job.ts:23`, so this adds no new dependency direction.

### 4. Report honestly from `serviceCommand`

`src/service.ts:2082-2084` — the `console.log` inside `case "install":` — currently
prints an unconditional success line. Replace with:

```diff
     case "install":
       assertServiceEnvironmentMatchesInstall();
       assertServiceAuthEnvironment();
       await ops.install();
-      console.log(backend === "native"
-        ? "✅ opencodex native service installed + started (windowless, starts at boot, auto-restarts on crash)."
-        : "✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
+      {
+        const serving = await confirmServiceServing();
+        if (serving.ok) {
+          console.log(backend === "native"
+            ? `✅ opencodex native service installed + serving on port ${serving.port} (windowless, starts at boot, auto-restarts on crash).`
+            : `✅ opencodex service installed + serving on port ${serving.port} (auto-starts on login, auto-restarts on crash).`);
+        } else {
+          // Registration succeeded but no listener appeared. Saying "installed +
+          // started" here is what sent the 2026-08-02 reporter in a circle.
+          console.error(
+            `⚠️  Service registered, but no proxy answered within ${Math.trunc(SERVICE_INSTALL_HEALTH_MS / 1000)}s.`
+            + `\n   The supervisor may be re-exec'ing a failing command. Check: ${serviceLogPath()}`
+            + "\n   Then run 'ocx service status' — and 'ocx start' to serve in the foreground meanwhile.",
+          );
+          process.exitCode = 1;
+        }
+      }
```

`case "start":` (label at `src/service.ts:2092`; `ops.start()` at `:2093` and the
checkmark at `:2094`) gets the same treatment — it has the identical unconditional
`✅ service started.`

### Blast radius: `repairService`

`installLaunchd` is also reached from `repairService()` (`src/service.ts:1383`).
WP1's throw and this phase's confirmation therefore both apply to
`ocx service repair`, which previously could not fail this way. That is the
correct behavior — a repair that leaves the service unloaded should not report
success — but it is a new failure mode and must be stated in the phase's D
summary and in the docs-site note.

Existing coverage is unaffected: all four `repairService` tests
(`tests/service.test.ts:859-896`) inject `platform: "win32"` with explicit deps,
so none reach `installLaunchd`. Verified by reading the file.

### Budget: the update worker's `RESTART_TIMEOUT_MS`

The update worker runs `ocx service install` under `RESTART_TIMEOUT_MS = 60_000`
(`src/update/job.ts:44`, invoked at `:761`). Adding up to
`SERVICE_INSTALL_HEALTH_MS = 20_000` leaves 40s for the rest of install, which is
ample — but the number is deliberately below half the budget for that reason. Do
not raise it without re-checking that call site.

## MODIFY `tests/service.test.ts`

Clock convention follows the existing files (`let now = 0`; `sleep` advances it),
not an `advancingClock()` helper — that helper does not exist anywhere in `tests/`.

```ts
describe("confirmServiceServing", () => {
  it("returns the baked port once the proxy answers", async () => {
    let calls = 0;
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1",
      probe: async () => ++calls >= 2,
      sleep: async () => {}, now: () => 0, timeoutMs: 5_000,
    });
    expect(out).toEqual({ ok: true, port: 10100 });
  });

  it("gives up at the deadline instead of hanging", async () => {
    let now = 0;
    const out = await confirmServiceServing({
      port: 10100, probe: async () => false,
      sleep: async ms => { now += ms; }, now: () => now, timeoutMs: 2_000,
    });
    expect(out).toEqual({ ok: false, port: 10100 });
  });

  it("probes at least once even with a zero budget", async () => {
    let probes = 0;
    await confirmServiceServing({
      port: 10100, probe: async () => { probes += 1; return false; },
      sleep: async () => {}, now: () => 0, timeoutMs: 0,
    });
    expect(probes).toBe(1);
  });

  // The regression: a stale pidfile must not make a serving service look dead.
  it("probes the baked port rather than resolving through the pidfile", async () => {
    const seen: number[] = [];
    await confirmServiceServing({
      port: 18999, probe: async p => { seen.push(p); return true; },
      sleep: async () => {}, now: () => 0,
    });
    expect(seen).toEqual([18999]);
  });
});
```

## Docs

`ocx service install` gaining a non-zero exit and a new warning is user-facing.
Update the service page under `docs-site/` in this phase (English source; do not
let translated locales contradict it) — AGENTS.md review guidelines require it.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts tests/service-stop-verification.test.ts
bun run test
```

Plus a real render check: build the plist in a scratch `OPENCODEX_HOME` and
confirm `ProgramArguments` still contains the expected
`exec '<bun>' '<cli>' start --port <n>` shape.

## Done when

- A registered-but-silent service produces a warning and a non-zero exit, not a
  green checkmark.
- The confirmation probes the baked port, proven by the fourth test.
- Healthy installs are unchanged except the port now appears in the success line.
- `ocx service repair`'s new failure mode is documented.
