# 010 — design: `retryOn429` same-target wait-and-retry

의존: `000_research.md`

## Goal

Provider-level opt-in knob: on HTTP 429, wait (upstream `Retry-After` or a fixed interval)
and replay the identical request on the same key, up to `attempts` extra times, before the
existing multi-key failover runs. Default off → zero behavior change for existing setups.

## Surface

```jsonc
// ~/.opencodex/config.json → providers.<name>
"retryOn429": {
  "enabled": true,            // object presence also enables; false disables
  "attempts": 3,              // extra replays after the first 429 (1..20)
  "intervalMs": 5000,         // fixed wait when no usable Retry-After
  "maxIntervalMs": 60000,     // cap for any single wait
  "respectRetryAfter": true   // prefer the upstream Retry-After when parseable
}
```

## Implementation

- `src/types.ts`: `RateLimitRetryPolicy` interface + `OcxProviderConfig.retryOn429`.
- `src/config.ts`: zod schema entry (zod's default strip inside the object — an unknown key is
  dropped, never a config-rejecting error; the outer provider schema stays passthrough).
- `src/providers/key-failover.ts`: `rateLimitRetryPolicyFor` (normalize/default) and
  `rateLimitRetryDelayMs` (Retry-After seconds/HTTP-date → capped, else `intervalMs`),
  reusing the existing `parseRetryAfterMs` cooldown parser. Key-auth providers only: OAuth and
  forward credentials are never replayed on the same token.
- `src/usage/log.ts`: new `AttemptRecoveryKind` member `"rate-limit-429"`.
- `src/server/responses/core.ts`: in the pre-stream recovery loop, BEFORE the multi-key
  failover `while`, wait then `rebuildAndRefetch("rate-limit-429")`. Abort during the wait
  cancels the client request (the unread 429 body is released first). The retry budget lives
  OUTSIDE the recovery loop, so a 413/401 replay that comes back 429 cannot re-arm a fresh
  budget — bounded to `attempts` per request. After attempts are exhausted the existing
  failover and error mapping run unchanged. Covers Responses, chat completions, and routed
  Claude messages (they all enter `handleResponses`).

## Safety

- Pre-stream only: a 429 arrives before any bytes are relayed, so replaying the string-body
  request is lossless (same invariant as the transient-5xx layer in `lib/upstream-retry.ts`).
- Ordering: same-key retries run before failover, so "primary-first" users keep their key on
  rate-limit blips; failover still works after retries exhaust.
- Latency bound: worst case `attempts × maxIntervalMs` (default 3 × 60 s = 180 s) when
  honoring upstream `Retry-After`; `attempts × intervalMs` (default 15 s) when
  `respectRetryAfter=false` or no header is present.
- Abort during the wait: the sleep is abort-aware — when the server observes the client
  disconnect (Bun propagates this asynchronously, observed 1–10 s), the wait is interrupted,
  the unread 429 body is released, and the request is cancelled with 499 before any replay.
  Because the propagation is async, a replay can still precede the cancel if the interval
  elapses first; that is bounded by the same `attempts` budget.
- Concurrency: each request honors its own policy independently — no process-wide cooldown is
  shared between concurrent requests (unlike the Kiro 429 pattern). Opt-in and bounded, so a
  storm multiplies upstream volume by at most `attempts + 1` per request.
- Final 429 still carries `Retry-After` for clients that honor it (Claude Code).

## Tests

- `tests/rate-limit-retry.test.ts` — policy normalization (incl. OAuth/forward gating) +
  delay computation (seconds, HTTP-date, `0`, malformed, cap; deterministic) + abort during
  the wait: a directly-invoked `handleResponses` with a controlled abort signal returns 499,
  cancels the unread 429 body, and performs no further upstream sends (deterministic — no
  real-socket disconnect timing involved).
- `tests/usage-log.test.ts` — the `rate-limit-429` recovery kind survives persisted usage logs.
- `tests/server-rate-limit-retry-e2e.test.ts` — single-key replay to success, immediate
  passthrough without the knob, exhausted attempts surface 429, and retry-before-failover
  ordering with a 2-key pool.
