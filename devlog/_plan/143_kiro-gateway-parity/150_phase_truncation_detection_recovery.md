# Phase 150 (P2) - Kiro truncation detection and recovery

## Trigger

The original parity map and external review both flag Kiro truncation recovery
as missing. Current `parseKiroStream()` closes an open tool call and emits
`done` when the eventstream ends, even if the tool input never received a stop
event. That can turn an upstream cut-off into a successful Codex tool call with
partial or invalid JSON.

`kiro-gateway` has a broader truncation recovery subsystem. opencodex should at
least stop silently completing truncated Kiro tool calls and surface a clear,
redacted upstream truncation failure.

## Current state

- `src/adapters/kiro.ts` parses Kiro event JSON inline.
- A Kiro tool call is emitted as soon as a `name`/`input` event arrives.
- At stream EOF, `parseKiroStream()` currently emits `tool_call_end` for any
  open tool and then emits `done`.
- `bridge.ts` already treats an adapter `error` event as `response.failed`, and
  treats a generator EOF without `done`/`error` as `response.incomplete`.
- Kiro returns no authoritative usage frame, so ordinary text-only EOF must
  continue to be treated as normal completion.

## Diff plan

### ADD `src/adapters/kiro-truncation.ts`

Create a small helper module:

- `kiroTruncationReason(parsed: Record<string, unknown>): string | undefined`
  - Detect explicit truncation markers in event JSON:
    `finish_reason`, `finishReason`, `stop_reason`, `stopReason`,
    `completionReason`, `reason`, or `truncated: true`.
  - Treat string values containing `length`, `max_token`, `max-tokens`,
    `truncate`, `truncated`, `incomplete`, or `context_length` as truncation.
- `isCompleteKiroToolInput(input: string): boolean`
  - Treat empty input as complete only after a real Kiro `stop` event.
  - Parse non-empty accumulated input as JSON and require an object/array root.
- `kiroTruncationErrorMessage(reason?: string): string`
  - Return a user-facing, redacted message:
    `Kiro response truncated upstream before the tool call completed...`

### MODIFY `src/adapters/kiro.ts`

- Import the helper module.
- Extend `ParsedKiroEvent` with `type: "truncation"`.
- In `parseKiroEvent()`, return a truncation event when
  `kiroTruncationReason(parsed)` detects an explicit marker.
- Change `parseKiroStream()` tool handling:
  - Buffer Kiro tool starts/input chunks internally.
  - Emit `tool_call_start`, `tool_call_delta`, and `tool_call_end` only after a
    real Kiro `stop` event.
  - Preserve chunk boundaries when flushing a completed tool call.
  - Ignore duplicate `name` starts for the same open tool before input arrives.
  - If a new tool/content/truncation/EOF arrives while a tool is still open
    without `stop`, emit `error` with `kiroTruncationErrorMessage()` and return.
  - Do not emit `done` after a truncation error.
- Keep normal text-only EOF as `done` because Kiro has no usage terminal.
- Keep stream exception/error frame behavior from Phase 70 unchanged.

### MODIFY `tests/kiro-stream.test.ts`

Add regression tests:

- Normal completed tool call still emits start/delta/end/done in the same final
  event order, even though Kiro events are buffered until stop.
- Tool input stream ending mid-JSON without stop emits a clear truncation error,
  no `done`, and no partial `tool_call_delta`.
- Tool input stream ending with valid JSON but without stop is still treated as
  truncation because the upstream did not complete the tool call.
- Explicit Kiro length/truncation marker emits the truncation error and no
  `done`.
- Duplicate tool `name` events before input do not create duplicate tool calls.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-stream.test.ts tests/error-fidelity.test.ts`
- `wc -l src/adapters/kiro.ts src/adapters/kiro-truncation.ts tests/kiro-stream.test.ts`

## Commit

`fix(kiro): surface truncated tool-call streams`

## Explicit non-goals

- No full gateway-style persistent recovery memory.
- No attempt to classify ordinary text EOF as truncation without an explicit
  marker; Kiro has no terminal usage frame, so that would create false
  positives.
- No new `AdapterEvent` schema. Truncation is surfaced through the existing
  `error` event so streaming and non-streaming paths both fail closed.
