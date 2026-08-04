# 020 — Phase 2: anthropic empty-body 400 — observability + bounded retry

Evidence basis: `003_anthropic_400_research.md` (two live probes refute the
history-shape hypothesis; bare `Provider error 400` = empty upstream body =
edge-layer rejection). The original payload is gone and the state index
evicted the failing window, so the fix targets the two things that are true
regardless of which edge condition fired: the incident was undiagnosable from
the ledger, and the proxy treated a transient edge 400 as a hard client error.

## Diff-level plan

### Commit 1 — observability: persist the real error shape

MODIFY `src/server/responses/core.ts` (error path ~2807-2828):
- When `errorText` is empty/whitespace, build the client-facing message as
  `Provider error <status> (empty upstream body)` instead of a bare
  `Provider error <status>: ` — the marker makes edge rejections
  distinguishable from validation 400s everywhere the message propagates.

MODIFY `src/server/request-log.ts` (`captureUpstreamError*`, 614-669):
- Verify the non-streaming error response body actually reaches
  `captureUpstreamError` on this path (the failing rows show it did not, or
  the message itself was bare). Add the `(empty upstream body)` marker to the
  persisted `upstreamError` so `usage.jsonl` always records WHICH 400 class
  fired. Never persist more than the existing 500-char redacted bound.

TEST (new, e.g. `tests/anthropic-empty-body-400.test.ts`):
- Fake upstream returns 400 with empty body → client sees
  `Provider error 400 (empty upstream body)`; persisted usage entry's
  `upstreamError` contains the marker.
- Fake upstream returns 400 with an Anthropic JSON error body → message and
  persisted field contain the redacted upstream `error.message` (today's
  behavior, pinned).

### Commit 2 — resilience: single retry on empty-body 400

MODIFY `src/server/responses/core.ts` recovery loop (same region as the
existing 429-rebuild and 413-image-tier recoveries):
- New recovery kind `empty-body-400`, gated to the anthropic adapter, status
  400, and a truly empty/whitespace upstream body (read bounded, once — the
  body is consumed by the check and the message path reuses the captured
  text; do not double-consume the stream).
- At most ONE retry per request (spiral guard like `imageRetryAttempted`),
  same rebuilt request. A second empty-body 400 returns the error with the
  marker from commit 1.
- JSON-body 400s never enter this path (validation errors stay fail-fast).

TEST (same file):
- Fake upstream: first response 400 empty, second 200 → client gets 200;
  exactly two upstream calls observed.
- First 400 empty, second 400 empty → client gets 400 with marker; two calls.
- 400 with JSON error body → no retry, one call, error surfaced.
- Non-anthropic adapter 400 empty → no retry (gate pinned).

## Deliberately not in this fix

- No history flattening (refuted by probes 1-2).
- No retry on body-carrying 400s, no blanket 400 retry.
- No changes to thread-spawn state handling.
- Manual-mode thinking + forced `tool_choice` is a separate documented 400
  class; it produces a JSON body, so it stays fail-fast and diagnosable via
  commit 1's pinned behavior.

## Accept criteria (activation scenarios)

- The retry path is proven by the fake-upstream test matrix above — the
  empty-body gate, the spiral guard, and the adapter scoping each have a
  dedicated test.
- `bun run typecheck` 0 errors; focused suites green; full `bun run test` on
  `ssh lidge` no worse than baseline; `bun run privacy:scan` passes.
- PR body states the evidence chain (probes, bare-message analysis) and the
  residual uncertainty (original upstream condition unprovable after state
  eviction) honestly.
