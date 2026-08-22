# 310 — big-context maxMode A/B (billing approved)

## Question

Does RequestedModel.maxMode=true actually EXTEND usable context on a
maxMode-capable model (claude-opus-4-8-high-fast, static window 200K)?
Small-turn A/B showed the server accepts both values with no delta; the
decisive test is a payload ABOVE the normal window.

## Design (2 runs, billing approved by user)

- Payload: ~230K tokens of filler text + a needle question (verify the
  needle to prove the context was actually consumed, not truncated).
- Run A: maxMode=false -> expect bare RE (overflow) or truncation.
- Run B: maxMode=true -> if it completes AND answers the needle, maxMode
  extends context: IMPLEMENT propagation (discovery retains maxMode per
  model; protobuf-request sets RequestedModel.maxMode for capable ids;
  registry context window bump gated on the flag).
- If B fails identically: NOOP — flag is cosmetic on this plan; record and
  keep hardcoded false.

## Hygiene

Transcripts redacted; raw dumps in probe-host scratch, deleted after
verdict. Cost cap: exactly 2 runs (~460K input tokens total). Abort rule:
if run A errors before body completes upload, do not burn run B; record
BLOCKED-transport.
