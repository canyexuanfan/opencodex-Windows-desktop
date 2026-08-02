# 040 — Fix #844: Cursor Connect incremental remainder + partial-EOF failure

Depends on: 001 root-cause delta. Header-time validation, 32/16 MiB caps, and 1,024-frame flow control already landed; this closes the concat-first growth and the silent partial-EOF discard.

## File map

- MODIFY `src/adapters/cursor/live-transport.ts`
  - Pending-chunk handling (~:894, `concatBytes()` :906-918): replace concatenate-first with incremental completion — append only the bytes needed to complete the current header (5 bytes) then the current payload, leaving at most ONE bounded incomplete frame carried between chunks. Preserve translator reservations, copy-overlap accounting, frame-slot backpressure, and rollback.
  - EOF handling (~:949): when the stream ends and a bounded incomplete remainder exists (after queued async `frameWork` settles), fail the turn with typed `frame_incomplete` — today complete-frames-plus-trailing-partial settles successfully and silently discards. Expected client-tool cancellation must NOT produce this error.
  - Terminal paths: explicitly release any remaining pending-payload lease on every settle path.
- MODIFY `src/adapters/cursor/framing.ts` (only if the streaming decode helper belongs there — wrap/extend :129, accepting the existing max-payload + reservation callbacks; keep `decodeConnectFrame` semantics for existing callers).
- MODIFY `tests/cursor-framing.test.ts` + `tests/cursor-hardening.test.ts`: new regressions (below).

Scope OUT: raising the 16 MiB effective inbound cap (recorded decision in 001 — PR #844's flat 32 MiB breaks the copy-overlap budget), outbound uint32 framing (`framing.ts:59` stays), header-byte accounting (frame-count flow control defends tiny-frame floods; documented).

## Acceptance + activation scenarios

1. Chunked delivery of one frame split across many small chunks: pending buffer never exceeds one frame + header; byte accounting matches the old concat path's final state. Activation: chunk-size sweep test (1,3,7,64 KiB chunkings) asserting identical decoded frames and bounded high-water pending bytes.
2. Complete frame + trailing partial frame + EOF: turn fails typed `frame_incomplete`; the completed frame was still delivered. Activation: hardening test driving exactly this sequence (red on pre-fix tree — today it settles clean).
3. EOF with only partial header (<5 bytes): same typed failure. Activation: variant of #2.
4. Expected cancellation with pending remainder: no `frame_incomplete`. Activation: cancellation fixture.
5. Oversized declared length is still rejected at header arrival (existing behavior preserved through the refactor). Activation: existing :124 tests stay green.
6. 1,024-frame flood + rollback behavior unchanged. Activation: existing :155 tests stay green.
7. Red-green: #2 and #3 red on the pre-fix tree.

## Regression risks (watch in C)

- EOF must wait for already-admitted async frame work before declaring incompleteness.
- Compressed/end-stream flags and frame order preserved.
- HTTP/2 pause/resume (frame-slot backpressure) must keep working with incremental decode.
