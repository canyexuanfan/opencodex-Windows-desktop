# 003 — Anthropic 400 on new-session spawn: research

## Symptom

2026-08-05 00:21-00:23 KST: three consecutive 400 `invalid_request_error`
responses against `anthropic/claude-opus-5` (effort high), all in conversation
`2c0f87c664e130b3927c4884fafd8283` (`ocx-mset3lcs-1i1`, `ocx-mset3rk6-1i6`,
`ocx-mset4i2p-1ik`), plus one in `7f8dbd4a06336b01da0d476fb65b38f2` at 00:23.
Same model+effort returned 200 for other conversations from 00:26 onward,
including 319K-620K-token inputs. Model alias failure, auth failure, and
context overflow are excluded.

Local evidence gap: `usage.jsonl` records only `Provider error 400` — the
upstream error body was not retained for these responses-inbound failures
(compare 2026-08-01 rows, which preserved the full Anthropic error JSON).

## Root cause — REFUTED hypothesis and what the live probes proved

The initial lane-C hypothesis (unsigned foreign tool_use + adaptive thinking →
400) is **refuted by two live probes** run through the local proxy against the
real Anthropic API on 2026-08-05 ~01:00 KST:

- Probe 1 (synthetic): inline `custom_tool_call` + `custom_tool_call_output`
  history, `anthropic/claude-opus-5`, effort high → **200** (134 tokens).
- Probe 2 (exact parent state): the full 923,656-byte item list of
  `resp_050cd54528dd6d7f…` (the last successful state at 00:21:12, 46s before
  the first failure) + a new user message, same model/effort → **200**
  (297,376 input tokens).

Anthropic's current extended-thinking contract matches probe 1: adaptive
thinking does not require a thinking preface on replayed tool-use turns.
The history shape is exonerated. (A-gate audit round 1, blocker 1.)

What remains consistent with every observation: the logged `upstreamError` is
bare `Provider error 400` — on the direct (non-combo) path the client-facing
message embeds the upstream body (`src/server/responses/core.ts:2807-2828`),
so a bare message means the 400 carried an **empty body**. Anthropic
validation 400s always carry a JSON error body (cf. the 2026-08-01
`prompt is too long` rows in the same ledger). An empty-body 400 in a
393-420ms window, clustered at 00:21:58-00:23:16 across two conversations and
self-healing by 00:26, is an **edge-layer rejection** (fronting/WAF/rate
shape), not schema validation. The user's GUI showed the generic
"프록시가 요청을 이해할 수 없습니다" because the proxy received no
upstream detail to forward.

## Original research record (kept for provenance)

Each failure happened exactly when resuming the next turn after a
`custom_tool_call_output`. Reconstruction of the failing body from saved
Responses state + rollout items shows:

```json
{ "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" }, "max_tokens": 24576 }
```

with history containing assistant turns of shape `[text, tool_use]` with **no
thinking/redacted_thinking block**, followed by `user: [tool_result]`.

Mechanism (later refuted by probes 1-2 above):

1. `previous_response_id` expansion merges stored input regardless of which
   provider produced the earlier turns (`src/responses/state.ts:857-860`).
2. The Responses parser restores foreign `custom_tool_call` items as assistant
   tool calls but cannot fabricate a valid Anthropic-signed thinking block
   from OpenAI/Grok reasoning (`src/responses/parser.ts:510-517`, envelope
   handling at 439-475; unsigned fallbacks fail
   `isLikelyRealAnthropicThinkingSignature`, `src/adapters/anthropic.ts:240-244`).
3. The Anthropic adapter drops unsigned thinking parts
   (`isLikelyRealAnthropicThinkingSignature`, `src/adapters/anthropic.ts:601`)
   but still emits the `tool_use` blocks (`src/adapters/anthropic.ts:604-607`),
   then turns adaptive thinking on for the whole request
   (`src/adapters/anthropic.ts:834-835`).
4. Anthropic 400s: with thinking enabled, an assistant tool-use turn must be
   preceded by a thinking/redacted_thinking block.

Secondary hypothesis (prefixed model ID missing the adaptive gate on older
runtimes, fixed by `930efdf60`/`f728dc0fb`) does not fit: the running process
started 2026-08-04 22:45 KST from a checkout containing both fixes, and the
reconstructed body was already `adaptive`.

Latent-path activation: `787bd1541` exposed Opus 5 in the catalog
(`src/providers/registry.ts:240`); the regression is not the alias but the
first time an adaptive-thinking model replayed foreign tool history.

## "New session" interpretation

`conversationId` is a log-correlation hash, not a continuation key
(`src/server/request-log-conversation.ts:30-38,64-75`). History replay is decided by
`previous_response_id`. The failing "new prompt/spawn" inherited the parent's
Responses chain — the proxy must not clear state on thread-spawn headers
(that would break intentional context inheritance).

## Fix direction

Revised after the probes (see `020_phase2_anthropic_400_fix.md`):

1. Observability: persisted `upstreamError` must distinguish an empty-body
   400 from a body-carrying one, so the next occurrence is diagnosable from
   `usage.jsonl` alone. Persistence capture lives in
   `src/server/request-log.ts:614-669` (`captureUpstreamError*`).
2. Resilience: a single bounded retry on empty-body 400 (anthropic adapter
   scope), treating it as the transient edge condition it evidences; JSON-body
   400s stay fail-fast.
3. NO history flattening (refuted hypothesis); no signature fabrication; no
   state clearing on thread spawn.
