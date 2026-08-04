# 020 — Phase 2: anthropic 400 on foreign tool-history replay (fix + regression tests)

Root cause and evidence: `003_anthropic_400_research.md`. One sentence: with
thinking enabled (adaptive on Opus 5), the adapter emits assistant `tool_use`
turns that have no signed thinking preface when the tool history came from a
different provider, and Anthropic 400s the request.

## Diff-level plan

### MODIFY `src/adapters/anthropic.ts`

1. Hoist the thinking-mode decision above the message conversion. Today
   `buildRequest` calls `messagesToAnthropicFormat(parsed, toolNames)`
   (~line 786) before the thinking block (~lines 820-856). Compute the
   thinking mode first (`disabled` | `adaptive` | `budget` | `off`), using the
   existing gates (`modelUsesAdaptiveThinking`, effort parsing), then pass it
   down. No behavior change for the body fields themselves — same conditions,
   same values, only ordered earlier.
2. Extend `messagesToAnthropicFormat` with an options parameter
   `{ flattenUnsignedToolUseTurns: boolean }` (true when the mode is
   `adaptive` or `budget`). In the `assistant` branch:
   - Track whether any thinking/redacted preface block was actually pushed
     (a real `isLikelyRealAnthropicThinkingSignature` pass or a redacted
     block).
   - If flattening is on, the turn contains tool calls, and no signed
     thinking preface exists, do NOT emit `tool_use` blocks. Instead append
     one text block per call via a new helper `foreignToolCallText(tc)`
     (mirrors `orphanToolResultText` at ~line 545):
     `[assistant called tool "name" (id) with arguments: <json, truncated>]`.
   - Leave `toolUseIds` empty for that turn so the pairing loop is skipped;
     the following `toolResult` messages then flow through the existing
     orphan-text path unchanged.
3. Never flatten turns that carry a real signed thinking block; byte-preserved
   replay of genuine Anthropic history is unchanged. Never fabricate
   signatures.

### Observability (same PR, second commit)

4. Trace why `usage.jsonl`'s `upstreamError` stayed `Provider error 400`
   without the body for responses-inbound failures. The redacted 500-char
   message is built at `src/server/responses/core.ts:2549`; find the hand-off
   to the persisted usage entry (`src/server/request-log.ts`,
   `src/usage/log.ts`) and carry the bounded redacted message (never the raw
   body) into the persisted field. Add a focused test that a 400 from a fake
   upstream lands in `usage.jsonl` with its `error.message` text.

### Tests — `tests/` (new file or extend the anthropic adapter suite)

5. Foreign `custom_tool_call` + `custom_tool_call_output` history converted
   for `claude-opus-5` high: no structured `tool_use` without a thinking
   preface; flattening text is present; `thinking: adaptive` and
   `output_config.effort: high` preserved.
6. Same history with a valid `ocxr1`-format signature: thinking block,
   signature, tool IDs replayed byte-preserved; no flattening.
7. `reasoning: none` and a non-adaptive family model: existing structured
   replay unchanged (flattening off).
8. Integration: `/v1/responses` with `previous_response_id` expansion over a
   foreign tool turn into Opus 5 against a fake Anthropic upstream → 200.
9. Same `session_id` without `previous_response_id` does not replay state
   (guard against "thread spawn clears state" regressions).

## Scope boundary

- IN: `src/adapters/anthropic.ts`, the error-persistence hand-off files named
  in step 4, new/extended tests.
- OUT: parser changes (`src/responses/parser.ts`), state expansion policy,
  other providers, combo error classification, any prompt-level workaround.

## Accept criteria (activation scenarios)

- Test 5 proves the exact failing shape (foreign tool history + adaptive
  thinking) now produces a body Anthropic accepts — asserted structurally on
  the built request, and end-to-end in test 8 with the fake upstream.
- `bun run typecheck` 0 errors; focused suites green; full `bun run test` on
  `ssh lidge` no worse than the recorded baseline; `bun run privacy:scan`
  passes (flattened text must pass through `redactSecretString`).
