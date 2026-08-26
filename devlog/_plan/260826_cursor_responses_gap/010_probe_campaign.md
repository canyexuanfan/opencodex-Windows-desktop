# 010 — Probe campaign (wp2 decade doc)

Instrument: local proxy `localhost:10100` /v1/responses, opencodex
2.32.1-preview.20260825. Subject: `cursor/grok-4.6`. Controls:
`xai/grok-4.6` (C1), `cursor/claude-opus-5` + `cursor/gemini-3.7-flash`
(C2). Subagent fleet: native spawn_agent — sol medium default + explicit
cursor-model workers (S1), plugin-surface exposure (S2), all fenced to
read-only tasks or mktemp scratch.

Verifier (from 000 plan):
`rg -c '^\| (P|C|S)[0-9]' devlog/_plan/260826_cursor_responses_gap/010_probe_campaign.md`
pass condition >= 10 evidence rows.

Bounds: <=30 live probes, <=3 retries/class, ~40min wall clock.

## Evidence rows

| ID | Class | Model | Result | Evidence |
|---|---|---|---|---|
| P1a | plain | cursor/grok-4.6 | PASS | resp_8c23ca0d, "PONG", usage in=11913/out=14, reasoning_tokens=0 |

## Per-probe notes

### P1a (smoke, pre-campaign)

Request: `{"model":"cursor/grok-4.6","input":"Reply with exactly: PONG","stream":false,"store":false}`.
Observation: correct text, but input_tokens=11913 for an 6-word prompt —
the adapter injects its full system/tool preamble even for a bare request.
Flag for 020: token-cost floor.
