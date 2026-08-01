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
- `src/config.ts`: zod schema entry (strip-unknown, so a typo degrades instead of
  rejecting the whole config).
- `src/providers/key-failover.ts`: `rateLimitRetryPolicyFor` (normalize/default) and
  `rateLimitRetryDelayMs` (Retry-After seconds/HTTP-date → capped, else `intervalMs`),
  reusing the existing `parseRetryAfterMs` cooldown parser.
- `src/usage/log.ts`: new `AttemptRecoveryKind` member `"rate-limit-429"`.
- `src/server/responses/core.ts`: in the pre-stream recovery loop, BEFORE the multi-key
  failover `while`, wait then `rebuildAndRefetch("rate-limit-429")`. Abort during the wait
  cancels the client request. After attempts are exhausted the existing failover and error
  mapping run unchanged. Covers Responses, chat completions, and routed Claude messages
  (they all enter `handleResponses`).

## Safety

- Pre-stream only: a 429 arrives before any bytes are relayed, so replaying the string-body
  request is lossless (same invariant as the transient-5xx layer in `lib/upstream-retry.ts`).
- Ordering: same-key retries run before failover, so "primary-first" users keep their key on
  rate-limit blips; failover still works after retries exhaust.
- Latency bound: `attempts × intervalMs` (default 3 × 5 s = 15 s max added latency).
- Final 429 still carries `Retry-After` for clients that honor it (Claude Code).

## Tests

- `tests/rate-limit-retry.test.ts` — policy normalization + delay computation (deterministic).
- `tests/server-rate-limit-retry-e2e.test.ts` — single-key replay to success, immediate
  passthrough without the knob, exhausted attempts surface 429, and retry-before-failover
  ordering with a 2-key pool.
