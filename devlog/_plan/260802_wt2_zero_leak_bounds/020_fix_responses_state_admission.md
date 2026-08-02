# 020 — Fix #841: Responses state admission boundary (direct-spill oversized, bounded snapshot read, bounded replay)

Depends on: 001 root-cause delta. NOT a redo of wave-1 (`d1408b92f` hard cap + spill already landed).

## File map

- MODIFY `src/responses/state.ts`
  - `setResidentEntry()` (~:243): before `replaceMapEntry()`, when `candidate.sizeBytes > byteCap()`, write the candidate DIRECTLY to spill and atomically install only its measured stub. Never insert the oversized candidate as resident; never demote unrelated residents to make room for it.
  - `ensureLoaded()` (~:453): bound the snapshot file read — `statSync` first, refuse (or truncate-refuse with typed error + quarantine) a `responses-state.json` above an explicit ceiling (recommend 32 MiB, above the 24 MiB write bound). Enforce direct-spill/reject for oversized resident rows BEFORE map admission in `loadSnapshotEntry()` (~:301).
  - `writeBoundedSnapshot()` (~:485): use `Buffer.byteLength(value, "utf8")` instead of `.length` for the 2 MiB/24 MiB limits.
- MODIFY `src/responses/spill-store.ts`
  - `readResponseSpill()` (~:307): reject `payloadBytes` above an explicit replay ceiling BEFORE read/parse (recommend the same 64 MiB as the store cap), typed error `spill_payload_too_large`; the continuation then fails as a structured `previous_response_not_found`-class miss rather than an unbounded allocation.
- MODIFY `tests/responses-state.test.ts` — new regressions (below).

Scope OUT: changing TTL (1h), count cap (1,000), stub/tombstone semantics, Windows ACL/fsync behavior, `previous_response_not_found` wire shape.

## Acceptance + activation scenarios

1. Oversized candidate (sizeBytes > cap) with two unrelated small residents present: candidate lands as spill stub only; both unrelated residents remain resident (not demoted). Activation: test asserting map contents + stub presence + spill file exists; replay of the stub still works.
2. At-cap-minus-epsilon candidate: admitted resident as today. Activation: boundary test.
3. Externally oversized snapshot file (> ceiling): load refuses with typed error, process starts with empty state, no giant parse allocation. Activation: fixture writing a >ceiling `responses-state.json` in a temp config dir.
4. Oversized spill payload on disk: replay rejects typed before read; no unbounded allocation; error surfaces as structured continuation miss. Activation: fixture spill file over the replay ceiling.
5. Multibyte snapshot: entries whose UTF-8 bytes exceed 2 MiB but whose `.length` does not are now correctly excluded from snapshot output. Activation: multibyte fixture + byte-length assertion.
6. Red-green: each new test fails on the pre-fix tree (verify at least #1, #3, #4 red first).

## Regression risks (watch in C)

- Continuation misses if direct-spill breaks same-ID crash consistency or deferred old-generation unlink ordering.
- Stubs must stay NON-evictable in `responseContinuationRetainedStoreSnapshot()` (counted as pinned) or the shared budget spins.
- v1/v2 snapshot compatibility; provider continuation metadata replay.
