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
| P2a | streaming | cursor/grok-4.6 | PASS* | SSE seq: created, output_item.added, content_part.added, 9x output_text.delta, content_part.done, output_text.done, output_item.done, completed. Missing: response.in_progress event (Codex clients tolerate; spec emits it) |
| P3a | single tool | cursor/grok-4.6 | PASS* | function_call get_weather {"city":"Seoul"} emitted; call_id contains embedded NEWLINE: "call-9aee...-0\nfc_5a1a...__0" — two ids glued with \n |
| P4a | multi tool parallel | cursor/grok-4.6 | PASS* | 2 function_calls (Seoul, Tokyo) in one response; same newline call_id shape on both |
| P5a | tool-result round trip | cursor/grok-4.6 | PASS | echoed newline call_id accepted back; final "21°C sunny"; in=10346 |
| P6a | apply_patch freeform | cursor/grok-4.6 | PASS | custom_tool_call with valid "*** Begin Patch\n*** Add File: hello.txt\n+alpha\n+beta\n*** End Patch" envelope; in=1078 |
| P7a/b | previous_response_id | cursor/grok-4.6 | PASS | store:true chain; turn2 recalled "737"; in=12225 |
| P8a | reasoning item replay | cursor/grok-4.6 | PASS* | reasoning item in input accepted (no 4xx); answer "apple" correct; reasoning_tokens=0 in ALL cursor responses (reasoning never surfaced) |
| P9a-c | concurrent x3 | cursor/grok-4.6 | PASS | 3 parallel curls all HTTP 200, 3.4-4.0s, correct N1/N2/N3, no cross-talk |
| P11a | 5-turn tool chain | cursor/grok-4.6 | PASS | t1 call slot A -> t2 result 41 -> t3 call slot B -> t4 result 59 -> t5 sum "100" correct. in_tokens: 268 -> 10383 -> 10405 -> 10640 -> 10744 |
| P12a | 77KB ANSI/unicode tool result | cursor/grok-4.6 | PASS | ESC bytes + 한글 survived round trip; model read TOTAL_CHARS=77400 correctly; in=33341 |
| C1a | control: tool round trip | xai/grok-4.6 | PASS | same P5 shape; in=529 (vs cursor 10346 — 20x smaller) |
| C1b | control: reasoning replay | xai/grok-4.6 | PASS | native reasoning item RETURNED in output, reasoning_tokens=143 (cursor route: always 0) |
| C2a | control: cross-model | cursor/claude-opus-5 | FAIL | status:"failed", error "Cursor upstream error: Cursor Connect error not_found" (both P5-shape and plain retry); model advertised in catalog but unusable |
| C2b | control: cross-model | cursor/gemini-3.7-flash | PASS* | P5 shape ok; in=14846 — highest preamble floor of all routes |

## Per-probe notes

### P1a (smoke, pre-campaign)

Request: `{"model":"cursor/grok-4.6","input":"Reply with exactly: PONG","stream":false,"store":false}`.
Observation: correct text, but input_tokens=11913 for an 6-word prompt —
the adapter injects its full system/tool preamble even for a bare request.
Flag for 020: token-cost floor.

### Cross-cutting observations (curl phase)

1. **Token floor**: every cursor-route request pays a ~10-15K input-token
   preamble (P1a 11913, P5a 10346, P8a 10174, C2b 14846) even with zero
   caller tools; xai route pays 229-529 for identical shapes. The adapter
   injects its native tool catalog + system scaffolding unconditionally.
   P3a is the exception (in=272): when the caller supplies function tools,
   the preamble collapses — the floor comes from the DEFAULT native
   toolset advertisement.
2. **call_id newline gluing** (P3a/P4a): the Responses-visible call_id is
   `call-<uuid>-<n>\nfc_<uuid>_<n>` — two identifiers joined by a literal
   newline. Round-trip works (P5a) because the adapter parses its own
   format, but any client that logs, splits, or validates call_ids on
   line boundaries breaks. Responses API ids are opaque but
   single-line by convention everywhere else.
3. **reasoning_tokens always 0** on cursor route (all probes) while
   xai/grok-4.6 emits a reasoning item + reasoning_tokens=143 for the
   same prompt: grok-4.6's thinking is either not requested or dropped
   by the cursor adapter — consistent with 001 S1 (reasoning never
   replayed for external wire models, protobuf-request.ts:237).
4. **cursor/claude-opus-5 dead in catalog** (C2a): advertised by
   /v1/models but every request fails upstream not_found. Catalog-serving
   honesty gap.
5. **No response.in_progress SSE event** (P2a) — minor spec parity gap.
6. Multi-turn continuity via previous_response_id (P7, P11) WORKS at the
   Responses surface — the seed thread's S1 re-orientation is therefore
   NOT a hard continuity break; it is the replay REPRESENTATION
   (flattened text + dropped reasoning) that causes re-orientation, plus
   in_tokens jumping 268 -> 10383 after the first tool round (P11a:
   checkpoint not reused across the tool boundary; full-replay fallback,
   001 S1 mechanism confirmed by token accounting).
