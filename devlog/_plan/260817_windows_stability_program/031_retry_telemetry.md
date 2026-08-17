# 031 — Instrument the retry envelope before widening it (F4)

**Depends on:** 030. This is a genuine dependency: there is nothing to count
until the primitive exists.

## Change

Count, do not change behavior.

Add to `src/lib/windows-atomic-replace.ts` (the module created in 030) a
module-scope counter keyed by `(code, publisher)` where `code` is the
`ErrnoException.code` that triggered the retry and `publisher` is a caller-
supplied string literal — `"config"`, `"prompt-journal"`,
`"config-ownership"`. Two counts per key: `retried` and `exhausted`.

Export `readWindowsReplaceRetryCounters()` returning a plain snapshot object.

Surface it through `handleSystemRoutes` in
`src/server/management/system-routes.ts:49`, which is where process-level
diagnostics already live. Add a sibling endpoint rather than extending the
existing one: `GET /api/system/windows-replace-retries` returning
`{ counters: { [key]: { retried, exhausted } } }`. `/api/system/memory`
(line 51) returns a memory-shaped payload and appending unrelated counters to it
would make both harder to consume.

The counters are process-lifetime and in-memory; they reset on restart, and that
is acceptable because the question is "does this ever fire at all", not "how
often per hour".

Route test: extend `tests/system-routes.test.ts` with a case asserting the
endpoint returns the snapshot shape and that a simulated retry (via the injected
`AtomicRenameIO` from 030) increments the expected key.

**Naming constraint:** the `publisher` value is a fixed literal chosen at the
call site. It must never be derived from a path, because a path can contain a
username. `privacy:scan` is the gate that enforces this and it must stay green.

## How the evidence is actually collected

In-memory counters cannot prove anything "across a release" on their own, so
the collection path is explicit:

- Local: run the proxy through a normal session, hit the diagnostics route,
  read the snapshot. Zero across ordinary use is itself a data point.
- CI: assert the counters exist and stay zero during the Windows suite. A
  non-zero `exhausted` count in CI is a defect, not telemetry.
- Field: only if a user voluntarily includes a diagnostics snapshot in a bug
  report. We do not collect this, and nothing in this phase transmits anything.

If those three sources produce no evidence within a release cycle, 032 does not
happen and this closes NOOP. That is a legitimate outcome.

## Verify

```powershell
bun run typecheck
bun run privacy:scan
bun test tests/config.test.ts
```

## Risk

Low. No behavioral change to the retry path itself. The privacy surface is the
only thing worth reviewing.
