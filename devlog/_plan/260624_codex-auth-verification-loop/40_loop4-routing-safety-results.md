# 40 - Loop 4 Routing and Safety Results

Status: planned.

Checks:

- Request log provider label distinguishes main `chatgpt` from pool `chatgpt-1`, `chatgpt-2`.
- Active account API returns expected next-session state.
- Auto-switch percent threshold applies to `max(5h, weekly, 30d when present)`, not weekly-only or 5h-only.
- Existing `autoSwitchThreshold` remains a percent field, default 80, and is not reused for failure counts.
- Optional 30d quota data is parsed, displayed, and included in `usageScore` only when WHAM/headers provide it.
- Consecutive non-200 upstream responses are counted per selected Codex account.
- A separate `upstreamFailoverThreshold`, default 3 and disabled at 0, controls failure-based failover.
- After the configured failure threshold, future new-thread routing moves to the lowest-usage available account without changing existing thread affinity.
- Token refresh failures and upstream non-200 responses do not delete existing thread affinity bindings.
- Redaction scan finds no newly committed raw token, refresh token, raw account id, or personal test fixture.
- Team/Business collision behavior is covered by regression tests.

Results: pending.
