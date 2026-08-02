# 030 — Fix #847: per-call scope in the non-stream collector + mandatory budget + 502 normalization

Depends on: 001 root-cause delta. Translator budgets already landed (`a61607894`); this closes the two narrow gaps and one contract inconsistency.

## File map

- MODIFY `src/chat/outbound.ts`
  - `collectChatCompletion()` (~:621, ~:700): open/close per-call ownership by stable tool-call index (fall back to call ID) and charge argument bytes as `tool_args` under that call scope — 2 MiB per call, 32 MiB per turn — including authoritative replacement snapshots (last-write-wins replaces, not accumulates). Today args charge to generic `retained_collectors`, so one call can eat the whole turn budget.
  - Overflow mapping: translator/tool overflow in the non-stream Chat path becomes 502 `upstream_error` (matching adapter/bridge), not 413 `invalid_request_error`.
- MODIFY `src/bridge.ts`
  - Option type (~:136): make `translatorBudget` mandatory. All production callers pass one today (`src/server/responses/core.ts:2644`); typecheck will catch any straggler — that is the point.
- MODIFY `tests/chat-outbound.test.ts` (or the collector's owning suite — confirm at P) + bridge tests: new regressions (below).

Scope OUT: the SSE record ceiling (stays 32 MiB — recorded decision in 001), routing OpenAI Chat through the shared SSE decoder (nice-to-have, separate unit), `service_tier` paths (wt3's lane), PR #847's 4 MiB/8 MiB numbers (native 2 MiB/call is STRICTER; keep).

## Acceptance + activation scenarios

1. Non-stream collector: a single tool call streaming >2 MiB of arguments fails typed (`translation_buffer_limit`-class) at the 2 MiB per-call boundary — not at 32 MiB. Activation: feed chunked arguments over 2 MiB under the test budget; assert typed overflow, no completed tool call in the collected result.
2. Two parallel calls each under 2 MiB but summing >32 MiB turn budget: turn-scope overflow fires. Activation: two-call fixture.
3. Done-frame authoritative snapshot larger than streamed deltas replaces (does not double-charge). Activation: delta-then-done fixture asserting final charged bytes.
4. Overflow surfaces as 502 `upstream_error` in the non-stream path. Activation: assert status+type on the mapped error (was 413).
5. Omitting `translatorBudget` from a bridge call is a compile error. Activation: typecheck (the negative is structural).
6. Red-green: #1 and #4 red on the pre-fix tree.

## Regression risks (watch in C)

- Mixed index/ID continuation chunks must attach to the same call scope.
- Releasing call ownership too early while the finalized output retains the argument string.
- 413→502 mapping: confirm no client relies on 413 for retry semantics (grep error-mapping consumers in `src/server/`).
