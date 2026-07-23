# 030 — WP3: RSS watchdog (warn-only) + authed /api/system/memory endpoint

Depends: WP1 (reports gate decision + streamMode). No core.ts dependency.

## NEW src/server/memory-watchdog.ts

```ts
export type MemorySample = {
  at: number;             // epoch ms
  rss: number;            // bytes
  heapUsed: number;       // bytes (process.memoryUsage)
  heapTotal: number;
};

export type MemoryWatchdogState = {
  samples: MemorySample[];          // bounded ring, default 360 (≈6h at 60s)
  warnThresholdBytes: number;       // default 4 GiB
  lastWarnAt: number | null;
};

export function startMemoryWatchdog(opts?: {
  intervalMs?: number;              // default 60_000
  warnThresholdBytes?: number;      // default 4 * 1024**3
  ringSize?: number;                // default 360
  now?: () => number;               // injectable
  sample?: () => MemorySample;      // injectable for tests
  warn?: (msg: string) => void;     // default console.warn
}): { stop(): void; snapshot(): MemoryWatchdogState };
```

- Warn-only: crossing threshold logs ONE rate-limited line (min 30 min between
  warns) naming rss, threshold, and the docs-site troubleshooting URL. NO
  restart (F4 deferral — stated in 050 docs).
- timer.unref() so it never holds the process open.
- Sampling is scalar-only (numbers) — privacy:scan safe by construction.

Wire-up: started in server startup path next to existing lifecycle init
(src/server/index.ts — find the Bun.serve construction / startup block at WP3's
P and hook start/stop into server start and drainAndShutdown).

## NEW route in management API: GET /api/system/memory

NEW src/server/management/system-routes.ts, registered in management-api.ts
next to handleConfigRoutes (:60). Auth: rides the existing /api/* gate
(requireApiAuth "management", index.ts:245) — handler itself does no extra auth,
same as sibling routes. NEVER on /healthz.

Response JSON:
```json
{
  "pid": 123, "bunVersion": "1.3.14", "bunRevision": "…", "platform": "darwin",
  "uptimeMs": 1234, "rss": 123, "heapUsed": 1, "heapTotal": 2,
  "jscHeap": { "heapSize": 1, "heapCapacity": 2, "objectCount": 3 },
  "streamMode": "auto", "eagerRelay": { "useEagerRelay": false, "reason": "auto-known-bad" },
  "watchdog": { "warnThresholdBytes": 4294967296, "lastWarnAt": null, "samples": [/* last 60 */] }
}
```
jscHeap via `import { heapStats } from "bun:jsc"` (scalar fields only, wrapped
in try/catch — discriminator js-vs-native, 001 §6 honesty framing).

## Activation scenarios

- GET /api/system/memory with valid token → 200 with rss>0, bunVersion match.
- Without token on non-loopback → same 401/403 as sibling /api routes.
- Watchdog: injected sampler exceeding threshold → exactly one warn per window;
  below threshold → zero warns; ring never exceeds ringSize.
- /healthz response shape UNCHANGED (regression assert).

## TESTS

- NEW tests/memory-watchdog.test.ts: ring bound, threshold warn rate-limit,
  stop() clears timer (fake timers/injected now).
- NEW/EXTEND management-route test (near existing tests/*management* or
  tests/*config-routes*): endpoint 200 shape + auth parity + /healthz unchanged.

## Verification (C)

- bun x tsc --noEmit; bun test tests/memory-watchdog.test.ts + route test;
  bun run test; bun run privacy:scan (endpoint emits scalars only).
