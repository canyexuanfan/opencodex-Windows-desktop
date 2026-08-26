# 080 — Fix F: G2/G4 instrumentation (codex/cursor-gap-6)

No deterministic local fix is provable yet: G2 (turn stall/degenerate
loop) needs an SSE trace of a stalling app session; G4 (" mar" token
splice) reproduced only under accumulated replay volume in a live
subagent. Honest scope: diagnostics capture, not a behavior fix.

## Diff plan

1. Provider diagnostics already expose continuationMode +
   checkpointInvalidationReason (protobuf-request.ts:933, cursor.ts:283)
   — surface them in the debug provider-diagnostic log line for every
   cursor turn (cheap, existing debug channel), so a stalling session's
   next report carries replay-state evidence.
2. ADD a bounded root-blob integrity check at assembly time: after
   building root blob candidates for external replay, verify the
   serialized text round-trips byte-identically (detect splice-class
   corruption at the source); on mismatch emit a debug diagnostic with
   offsets (no payload contents — privacy scan safe).
3. Document the capture procedure for the next stall occurrence
   (curl -N session mirror) in this doc.

## Accept criteria

- Diagnostic line appears for cursor turns under debug flag (test with
  debug seam).
- Integrity check triggers on an injected mutated blob (unit test with
  fault injection); silent on clean paths.
- privacy:scan stays green (no payload logging).
