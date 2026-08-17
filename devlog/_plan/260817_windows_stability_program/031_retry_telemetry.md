# 031 — Instrument the retry envelope before widening it (F4)

**Depends on:** 030.

## Change

Count, do not change. Each time the primitive from 030 retries, and each time it
exhausts its attempts, increment a counter tagged with the error code and the
publisher. Surface it wherever the existing diagnostic counters live — this must
not become a new logging surface, and per AGENTS.md it must never carry a path
that could identify the user, a request body, or a credential. Code and count
only.

## Why this phase exists separately

Both audits flagged the 75ms envelope. Neither could show it failing in the
field, and one explicitly declined to raise its severity for that reason. The
honest move is to measure first. If the counters stay at zero across a release,
the envelope is fine and this closes as NOOP. If they do not, 032 widens it with
bounded jittered backoff and cites the numbers.

## Verify

```powershell
bun run typecheck
bun run privacy:scan
bun test tests/config.test.ts
```

`privacy:scan` is the gate that matters here.

## Risk

Low. No behavioral change.
