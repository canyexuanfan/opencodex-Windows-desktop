# WP4 — Status must name the failure and the repair

Closes A2/A3 from `002_service_vs_start_asymmetry.md`. Depends on WP1.

Line numbers below were re-derived with `grep -n` against the working tree after
the round-1 audit found every R1 citation off by 5-370 lines.

## Problem

The reporter ran `ocx service`, got a green checkmark, hit a dead port, and had
no next step. Three surfaces failed them:

1. **`ocx service status` on darwin** returns
   `installed and loaded (launchd; logs: ~/.opencodex/service.log)` — "loaded"
   for a job that is bootstrapped from a *previous* plist and serving nothing,
   and the log path is buried mid-sentence.
2. **No listen port anywhere.** The user cannot tell "pinned to 10100 and dead"
   from "hopped to 51423 and fine". `runtime-port.json` holds the answer and is
   never surfaced.
3. **No repair command.** The Windows branch says
   `run 'ocx service install' to repair`; darwin/linux say nothing. After WP1 the
   correct darwin repair is often `launchctl bootout` first, which no surface
   mentions.

## MODIFY `src/service.ts`

### 1. darwin/linux status gains a liveness dimension

`diagnoseService()` darwin branch (`src/service.ts:1961-1971`) currently:

```ts
const summary = !installed ? `not installed (${diagnostics})`
  : stale ? `installed, but stale (launchd; ${diagnostics})`
    : running ? `installed and loaded (launchd; ${diagnostics})`
      : `installed, not loaded (launchd; ${diagnostics})`;
```

`running` here means "registered with launchd", which is not what the word means
to a reader. Rename the local to `loaded` and let the async status command layer
the real probe on top:

```diff
-    const running = installed && Boolean(statusLaunchd());
+    // `launchctl list` reports a job bootstrapped from an OLD plist exactly like a
+    // serving one, so this is registration, not service. The live probe lives in
+    // serviceStatusReport(); WP1's launchdJobMatchesPlist() answers the staleness half.
+    const loaded = installed && Boolean(statusLaunchd());
```

with `running: loaded` retained in the returned struct for compatibility, and a
comment naming the limitation. Do NOT make `diagnoseService()` async — it is
called from sync paths (`isServiceViable`, tray, `startup-health-cache`).

Optionally fold WP1's `launchdJobMatchesPlist()` into `stale` here. Decide at this
phase's P: it makes `diagnoseService()` shell out on every call, which the sync
callers above may not tolerate. Default is **no** — keep it in the async reporter.

### 2. New async reporter used by the CLI

```ts
/**
 * Status a human can act on: registration state (sync diagnostic), whether a proxy
 * actually answers, and — when it does not — whether launchd is running the plist
 * we think it is. `launchctl list` membership alone cannot distinguish "serving",
 * "bootstrapped from an older plist", and "loaded but never bound"; the 2026-08-02
 * report is the middle one presented as the first.
 */
export async function serviceStatusReport(
  deps: {
    diagnose?: () => ServiceDiagnostic;
    findProxy?: () => Promise<{ port: number } | null>;
    matchesPlist?: () => { loaded: boolean; matchesPlist: boolean };
  } = {},
): Promise<string> {
  const diag = (deps.diagnose ?? diagnoseService)();
  if (!diag.installed) return `❌ ${diag.summary}`;
  const live = await (deps.findProxy ?? (() => findLiveProxy()))();
  if (live) return `✅ ${diag.summary}\n   Serving on port ${live.port}.`;

  const stalePlist = process.platform === "darwin"
    ? (deps.matchesPlist ?? (() => {
        const entry = cliEntry();
        return launchdJobMatchesPlist(buildServiceShellCommand(entry.bun, entry.cli));
      }))()
    : null;
  const staleLine = stalePlist && stalePlist.loaded && !stalePlist.matchesPlist
    ? `   launchd is running an OLDER plist than the one on disk.\n`
      + `   Fix:    launchctl bootout gui/$(id -u)/${LABEL} && ocx service install\n`
    : "";

  return `⚠️  ${diag.summary}\n`
    + "   Registered, but no proxy is answering.\n"
    + staleLine
    + `   Log:    ${serviceLogPath()}\n`
    + "   Repair: ocx service install\n"
    + "   Meanwhile: ocx start           (serves in the foreground)";
}
```

`buildServiceShellCommand` (`src/service.ts:331`) takes `(bun, cli, port?)`. Call
it with the named fields rather than spreading `cliEntry()` — the expected command
must come from the same builder the plist uses, and an argument-order slip in the
one comparison that must not drift would produce a permanent false "stale" verdict
sending users to `bootout` for nothing.

### 3. Wire it into `case "status"`

The real code (`src/service.ts:2130-2137`) is:

```ts
case "status": {
  if (process.platform === "win32" && backend === "scheduler") {
    console.log(await inspectWindowsSchedulerServiceStatus());
  } else {
    const s = ops.status();
    console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
  }
  console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
  break;
}
```

`serviceStatusSummary()` (`src/service.ts:2010`) is **not** called here — its only
non-test caller is the import in `src/cli/index.ts:31`. The non-Windows branch
prints raw `ops.status()` output, which on darwin is a `launchctl list | grep`
line: the rawest possible form of "registration mistaken for service".

```diff
   } else {
-    const s = ops.status();
-    console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
+    console.log(await serviceStatusReport());
   }
   console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
```

`serviceStatusReport()` subsumes the old output: it already reports not-installed,
and adds the serving / stale-plist distinction. The `Diagnostics:` line stays — it
carries the log path and any `STALE baked paths` finding.

The Windows scheduler branch keeps `inspectWindowsSchedulerServiceStatus()`,
untouched.

No alias retirement in this phase: WP1 no longer renames
`bakedServicePathsDiagnostic`, so there is nothing to retire. (R1 planned that
rename; it was dropped with the stub narrative — see `003`.)

## MODIFY `src/cli/status.ts` (not `doctor.ts`)

Verified: `src/cli/doctor.ts` does not reference the service diagnostic at all.
The consumer is `src/cli/status.ts:171` (`const service = diagnoseService();`
→ `serviceSummary = service.summary`).

`ocx status` is the sharpest available fix here because it *already computes both
halves and never compares them*: `live` (an identity-probed `findLiveProxy`
result, `src/cli/status.ts:161-169`) sits a dozen lines above `serviceSummary`,
which reports `installed and loaded` regardless. The contradiction the user hit —
registered but not serving — is already fully determined in that function's local
scope and simply not stated.

```diff
 const service = diagnoseService();
-const serviceSummary = service.summary;
+// A service can be registered and still not serve: launchd re-execs a failing
+// command under KeepAlive while `launchctl list` keeps reporting the job. `live`
+// is already identity-probed above, so cross-check rather than report registration
+// as if it were service.
+const serviceSummary = service.installed && !live
+  ? `${service.summary} — registered but NOT serving; see ${serviceLogPath()} and re-run 'ocx service install'`
+  : service.summary;
```

`serviceStatusSummary()` (`src/service.ts:2010`) has exactly one non-test caller,
`src/cli/index.ts:31`. Confirm at B whether that call site should also move to the
richer reporter or stay as the terse one-liner.

## MODIFY `tests/service.test.ts`

```ts
describe("serviceStatusReport", () => {
  it("reports the serving port when a proxy answers", async () => {
    const out = await serviceStatusReport({ findProxy: async () => ({ port: 10100 }) });
    expect(out).toContain("Serving on port 10100");
  });

  // The reporter's exact situation: registered, nothing listening.
  it("names the log path and the repair command when nothing answers", async () => {
    const out = await serviceStatusReport({ findProxy: async () => null });
    expect(out).toContain("no proxy is answering");
    expect(out).toContain("ocx service install");
    expect(out).toContain("ocx start");
    expect(out).toContain("service.log");
  });
});
```

Both tests must inject `diagnose` as well as `findProxy`. `serviceStatusReport`
resolves `!diag.installed` before it ever probes, so a test supplying only
`findProxy` runs the real `diagnoseService()` and behaves differently on a machine
that happens to have a service installed. The `diagnose` seam exists in the
signature for exactly this reason — use it:

```ts
const installed = () => ({ ...baseDiagnostic, installed: true, summary: "installed and loaded (launchd)" });

it("names the log path and the repair command when nothing answers", async () => {
  const out = await serviceStatusReport({
    diagnose: installed,
    findProxy: async () => null,
    matchesPlist: () => ({ loaded: true, matchesPlist: true }),
  });
  expect(out).toContain("no proxy is answering");
});

it("adds the bootout hint when launchd runs an older plist", async () => {
  const out = await serviceStatusReport({
    diagnose: installed,
    findProxy: async () => null,
    matchesPlist: () => ({ loaded: true, matchesPlist: false }),
  });
  expect(out).toContain("OLDER plist");
  expect(out).toContain("bootout");
});
```

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts
bun run test          # full suite — this phase touches a widely-imported module
```

## Docs

Replacing `ops.status()` drops the raw `launchctl list` line from
`ocx service status`. That is intentional and an improvement, but it is a
user-visible change to a diagnostic command — fold it into the same `docs-site/`
note WP2 already requires rather than shipping it silently.

## Done when

- `ocx service status` distinguishes "registered", "running an older plist", and
  "serving".
- A dead service prints the log path, `ocx service install`, and `ocx start`, plus
  the `launchctl bootout` line when the running job is stale.
- `ocx status` no longer reports `installed and loaded` next to a failed health
  probe without comment.
