# 045 — Fix #845: bound the blob-ID key channel (audit round 1 refuted the NOOP)

Date: 2026-08-02. Verdict after audit: **REAL FIX REQUIRED.** Payload-side is fully bounded (16 MiB/entry, 64 MiB aggregate, 4,096 entries, 15-min TTL, pins, typed errors — `native-exec.ts:79`/`:219`/`:351`/`:551`), but the audit found the key channel unbounded: a remote `blobId` of arbitrary length becomes an unbounded, uncounted `Map` key (`native-exec.ts:219`, `:551`). ~16 MiB ID × 4,096 entries ≈ 64 GiB of pure key strings.

## File map

- MODIFY `src/adapters/cursor/native-exec.ts`
  - Admission (`setBlob`, ~:219/:296): validate the blob ID BEFORE insertion. Contract: conforming content-hash IDs (hex, fixed length — confirm the exact shape Cursor emits at P) pass through unchanged; anything else is either (a) rejected typed (`blob_id_invalid`/`blob_id_too_large`) or (b) stored under a fixed-size derived key `sha256(id)` with the raw ID never retained. DECIDE at P by checking what IDs the live protocol actually carries — prefer (a) reject when IDs are provably always content hashes (fail-closed, no aliasing); fall back to (b) digest only if arbitrary IDs are legitimate. Either way, retained key bytes become fixed-size and counted.
  - Lookup paths (`getBlobArgs`, hydration, scope pins) apply the SAME key derivation, or lookups miss (audit: key-derivation asymmetry between store and lookup is the primary regression risk).
  - Account key bytes in the store's byte accounting (snapshot `bytes`/`evictableBytes`), so the framework sees them.
- MODIFY `tests/cursor-blob.test.ts`: new regressions (below).

Scope OUT: the payload-side design (unchanged), true access-LRU (policy nicety, not a leak), the accepted residual (remote post-seal `setBlobArgs` TTL-only protection — matches PR's own limitation).

## Acceptance + activation scenarios

1. Oversized/non-conforming blob ID with tiny data: admission rejects typed (or digests — per P decision); retained store bytes stay bounded; the raw ID string is NOT reachable from the store's internals. Activation: fixture with a ~1 MiB ID asserting rejection (or fixed internal key) + bounded snapshot bytes (red on pre-fix tree — raw ID is retained as key).
2. Aggregate: 4,096 oversized-ID admissions cannot grow retained key bytes beyond the fixed bound. Activation: loop fixture with snapshot-bytes ceiling assertion.
3. Store→lookup symmetry: a conforming (or digested) ID round-trips: set then getBlobArgs returns the data. Activation: round-trip test for every accepted ID class.
4. Existing pin/scope/rollback suites stay green (`cursor-blob.test.ts:731-1141`, `cursor-live-transport.test.ts:164`).
5. Red-green: #1 red on the pre-fix tree.
