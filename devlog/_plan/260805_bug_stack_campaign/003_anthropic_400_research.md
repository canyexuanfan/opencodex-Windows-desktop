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

## Root cause (highest-confidence hypothesis, sol-medium lane C + main review)

Each failure happened exactly when resuming the next turn after a
`custom_tool_call_output`. Reconstruction of the failing body from saved
Responses state + rollout items shows:

```json
{ "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" }, "max_tokens": 24576 }
```

with history containing assistant turns of shape `[text, tool_use]` with **no
thinking/redacted_thinking block**, followed by `user: [tool_result]`.

Mechanism:

1. `previous_response_id` expansion merges stored input regardless of which
   provider produced the earlier turns (`src/responses/state.ts:843`).
2. The Responses parser restores foreign `custom_tool_call` items as assistant
   tool calls but cannot fabricate a valid Anthropic-signed thinking block
   from OpenAI/Grok reasoning (`src/responses/parser.ts:410,470`).
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
(`src/server/request-log-conversation.ts:56`). History replay is decided by
`previous_response_id`. The failing "new prompt/spawn" inherited the parent's
Responses chain — the proxy must not clear state on thread-spawn headers
(that would break intentional context inheritance).

## Fix direction

- When the request will run with thinking enabled (adaptive or budget) and an
  assistant tool-use turn has no valid signed thinking preface, flatten that
  turn's tool calls (and their results) into safe text history instead of
  structured `tool_use`/`tool_result` blocks.
- Never fabricate Anthropic signatures; real `ocxr1` signed history replays
  byte-preserved as today.
- Do not drop whole conversations on provider switch (context loss too large).
- Observability: get the bounded, redacted upstream `error.message` into
  `usage.jsonl`'s `upstreamError` for responses-inbound failures — the
  500-char redacted path exists at `src/server/responses/core.ts:2529` but
  the persisted field stayed bare for these rows; find why and close it.
