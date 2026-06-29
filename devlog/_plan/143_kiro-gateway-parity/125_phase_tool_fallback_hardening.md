# Phase 125 (P1 residual) - Kiro tool fallback hardening

## Trigger

Phase 120 closed JSON Schema sanitization only. The external code review still
flags three Kiro tool-compatibility gaps:

- Long tool descriptions are hard-truncated to 1024 chars.
- Tool results can still be sent as structured `toolResults` when no tool
  definitions are present.
- Orphaned tool results can still be sent as structured `toolResults` when the
  transmitted payload no longer contains the matching assistant `toolUse`.

## Current state

- `src/adapters/kiro-tools.ts` sanitizes schemas and returns raw Kiro tool
  specifications, but it truncates descriptions.
- `src/adapters/kiro.ts` converts every assistant `toolCall` to Kiro
  `toolUses`, and every `toolResult` to pending structured `toolResults`.
- Resume repair from Phase 100 preserves the previous assistant context for
  ordinary resumed tool-result turns, but malformed/no-tools inputs still need
  fail-closed text fallback.

## Diff plan

### MODIFY `src/adapters/kiro-tools.ts`

- Add a `convertKiroToolContext(parsed)` export returning:
  - `tools: unknown[]`
  - `systemAdditions: string[]`
- Keep `convertKiroTools(parsed)` as a compatibility wrapper returning only
  `tools`.
- If a tool description is over 1024 chars:
  - Replace the Kiro tool definition description with a short pointer such as
    `Tool documentation moved to the system prompt: <tool-name>.`
  - Add the full description to `systemAdditions` under a deterministic heading.
- Preserve existing schema sanitization behavior from Phase 120.

### MODIFY `src/adapters/kiro.ts`

- Import `convertKiroToolContext()` instead of only `convertKiroTools()`.
- Append `systemAdditions` to the payload system prefix. Unlike the stable
  system prompt, tool documentation additions should be present whenever the
  request includes tool definitions, including resumed requests, because Kiro
  receives the tool specs on the current request.
- Track structured assistant tool-use IDs while building the transmitted
  payload.
- If `parsed.context.tools` converts to zero Kiro tools:
  - Do not emit `assistantResponseMessage.toolUses`.
  - Do not emit `userInputMessageContext.toolResults`.
  - Render assistant tool calls and tool results as plain text context.
- If a `toolResult` has no matching earlier assistant tool-use ID in the
  transmitted payload:
  - Convert it to a plain user text entry.
  - Do not attach it as structured `toolResults`.
- Preserve current behavior for valid tool-call continuation payloads: matching
  assistant `toolUses` remain structured and matching `toolResults` stay
  adjacent.

### MODIFY `tests/kiro-adapter.test.ts`

Add regression coverage:

- Long tool descriptions are not lost: Kiro tool definition has a short pointer
  and the full description appears in the user/system-prefixed payload.
- No-tools fallback converts assistant tool calls and tool results to text and
  emits no structured `toolUses`/`toolResults`.
- Orphaned tool results with tools present convert to text and emit no
  structured `toolResults`.
- Existing resumed tool-result context test remains green.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-adapter.test.ts`
- `wc -l src/adapters/kiro.ts src/adapters/kiro-tools.ts tests/kiro-adapter.test.ts`

## Commit

`fix(kiro): fall back unsafe tool context to text`

## Explicit non-goals

- No truncation recovery state machine; Phase 150 owns stream/tool truncation.
- No payload-size trimming; this phase preserves long tool docs in the prompt
  but does not implement history trimming.
- No new tool schema sanitization beyond Phase 120 behavior.
