# 031 — wp4 diff spec: mid-stream envelope-echo detection (PR B1)

Evidence base: 021 F1/F2 — run-03 (macmini-cf) streamed three verbatim
"[Tool Result] [tool_result] call_id: ... output: ..." blocks INSIDE an
agent message, after legitimate leading text. The existing
CursorEnvelopeEchoSniffer stops looking after the first 40 bytes of the
turn (envelope-echo.ts MAX_SNIFF_BYTES), so mid-message echoes reach the
client uncorrected. One echoed block also carried the corrupted call-id
"fc_63367283 mar-2aec-..." (F2, 080's "mar" signature) — the model is
echoing the flattened replay envelope it was primed with.

## Branch/PR

Stays on the current stack: branch codex/cursor-midstream-echo, based on
codex/runturn-backlog-coalesce head (stacked PR; base PR #2774 targets
dev, this PR targets codex/runturn-backlog-coalesce until #2774 lands).
Rationale: same devlog unit carries both; no src overlap, but the devlog
history is linear on this chain.

## Changes

### 1. MODIFY src/adapters/cursor/envelope-echo.ts — mid-stream detector

ADD class CursorMidstreamEchoSniffer:
- feed(textDelta) maintains a rolling tail buffer (last 256 chars) of the
  full turn text and scans for NEWLINE-ANCHORED markers:
  /(^|\n)\s*\[Tool Result\]/ and likewise for "[tool_result]" and
  "[Tool Error]" appearing at a line start BEYOND the first-line window
  the prefix sniffer already owns.
- Detection returns { kind: "echo", marker } once; the caller treats it
  exactly like the prefix sniffer's echo verdict (retryable semantic
  failure). No holding/quarantine: mid-stream detection cannot un-emit
  already-released deltas, so the value is the RETRY (fresh conversation,
  corrective continuation text) rather than suppression — the same
  contract as gap-10's CursorToolResultEchoError but from a later offset.
  Note emittedOutput will be true by then; the retry gate in cursor.ts
  currently requires !emittedOutput. See change 2.
- Bound: scanning stops after MAX_MIDSTREAM_SCAN_BYTES = 512 * 1024 per
  turn (defensive; a turn that long without an echo is not echo-primed).

### 2. MODIFY src/adapters/cursor.ts — arm + retry policy

- Arm CursorMidstreamEchoSniffer alongside the prefix sniffer (same
  armEchoSniffer condition), feeding every text_delta AFTER guard release.
- On mid-stream echo: throw CursorToolResultEchoError only when the turn
  can still be retried safely: replayUnsafe false and NO client tool call
  emitted yet (emittedClientTool false). Since text deltas HAVE escaped,
  the retry emits an assistant_boundary continuation instead of silent
  replacement... NO — simpler audited contract: mid-stream echo does NOT
  retry; it emits a diagnostic (debugProviderDiagnostic
  "midstream-envelope-echo" with conversationHash, offset, marker,
  callIdCorrupt flag) and pushes a text_delta warning? ALSO NO — do not
  fabricate visible text. FINAL contract (see accept criteria): detection
  is diagnostic-only in this PR (counter + structured log), giving F2 the
  wire-side observability 030 asked for; the retry semantics for
  already-streamed echoes need their own design round with user-visible
  behavior decisions (NEEDS_HUMAN if pursued).
- callIdCorrupt detection: within a detected echo block, match
  /call_id: (\S+)/ and /fc_[0-9a-f]/ tokens; flag when a token matches
  /\smar-/ (the observed corruption) or call-id fragments split by
  whitespace. Logged as booleans/offsets only — no content bytes
  (privacy:scan constraint).

### 3. MODIFY tests/cursor-envelope-echo-retry.test.ts

- NEW: mid-stream echo after legitimate leading text triggers the
  detector exactly once, diagnostic carries marker + offset,
  callIdCorrupt=true for a "fc_x mar-y" specimen, false for clean ids.
- NEW: newline-anchored only — "[Tool Result]" inside a quoted sentence
  mid-line does NOT trigger (e.g. model legitimately discussing the
  string in prose after a code fence on the same line).
- NEW: scan disarms past MAX_MIDSTREAM_SCAN_BYTES.
- KEEP: all existing prefix-sniffer tests unchanged.

## Accept criteria + activation

1. bun test tests/cursor-envelope-echo-retry.test.ts exit 0; activation =
   the mid-stream specimen from run-03 (verbatim block pasted as fixture)
   fires the detector; line-start anchoring proven by negative case.
2. bun run typecheck exit 0.
3. Live (wp5): re-run N1 x6 on patched stack; any echo occurrence now
   appears in probe-proxy.log as midstream-envelope-echo diagnostic with
   callIdCorrupt evidence — closing the F2 observability gap.

## Out of scope

Retry/suppression for already-streamed echoes (user-visible behavior
decision), native zero-stdout marker (stays conditional), checkpoint
reserialization.
