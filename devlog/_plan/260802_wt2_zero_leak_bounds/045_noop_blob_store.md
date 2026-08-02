# 045 — #845 Cursor blob store: NOOP record (verified superseded)

Date: 2026-08-02. Verdict: **NOOP — no code change.** Evidence class: code-verified on `codex/wt2-zero-leak-impl` @ `478354ee8`.

## Why no change is needed

PR #845's headline items all exist on current dev, in a stronger native form:

| PR #845 item | Current dev |
|---|---|
| 16 MiB/entry, 64 MiB total, 4,096 entries | `src/adapters/cursor/native-exec.ts:79` — same numbers |
| 15-minute TTL | same, :79 |
| Pin every root/step/turn blob advertised by an active request | request scopes with seal/rollback, `:351`; construction pins at `protobuf-request.ts:306`; release on open failure/end/close/cancel/abort at `live-transport.ts:567`, `:665` |
| Evict only expired/LRU unpinned; fail when pinned data leaves no capacity | typed atomic admission failures `entry_too_large` / `pinned_saturation` / `request_pinned_conflict`, `:219` |
| Protobuf error for rejected `setBlobArgs` | `:551` + wire shape `gen/agent_pb.ts:7904` |

Native additions the PR lacks: identity-bearing scope tokens, per-key hydration release (`:537`), provenance classes, app-owned-memory integration, atomic rollback, richer metrics. The only unretained PR behavior is true access-LRU on `getBlob` — a policy nicety, not a memory-safety gap (TTL + byte/count caps + budget eviction bound retention regardless). Not implemented deliberately.

## Accepted residual (documented, matches PR's own limitation)

Remote `setBlobArgs` arriving after request-scope sealing cannot gain a request pin; it is TTL-protected (15 min) only. A request outliving 15 minutes could theoretically lose a late remote blob. PR #845 shares this limitation. If it ever bites, the fix is an ownership contract in `setBlob()`/`handleCursorNativeKv()` — separate unit, not this campaign.

## Verification

Existing suite coverage is extensive (`tests/cursor-blob.test.ts:731-1141`, `tests/cursor-live-transport.test.ts:164`). C-phase of this work-phase = run the blob suites fresh and record green output; no new tests.
