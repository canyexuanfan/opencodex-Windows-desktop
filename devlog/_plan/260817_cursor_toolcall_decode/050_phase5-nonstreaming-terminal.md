# 050 — Phase 5: a buffered turn that never terminated is not "completed"

The last follow-up recorded in `000_index.md`. Deferred from `010` pending
evidence; that evidence now exists and is worse than the note assumed.

## Measured, not assumed

`buildResponseJSON` defaults to `"completed"` whenever no error or incomplete
event is present (`bridge.ts:1830-1834`). Probed directly against the current
tree:

| Adapter events | Result |
|----------------|--------|
| `[text]`, no terminal | `status: "completed"`, no `incomplete_details` |
| `[tool_call_start, tool_call_delta("{\"code\":\"tru")]` | `status: "completed"` with a `function_call` item, `status: "completed"`, `arguments: "{\"code\":\"tru"` |
| same + `tool_call_end` | `status: "failed"`, item `status: "incomplete"` |

The second row is the defect. A truncated tool call — invalid JSON, never closed —
is handed back as a **successful** turn containing an apparently complete
function call. A caller that trusts `status` will try to execute it.

The third row is the same bridge, on the same arguments, getting it right. The
rejection logic already exists (`bridge.ts:1070-1080`); it is reached only when
an explicit `tool_call_end` arrives. When the stream simply stops, nothing runs
it.

## Why this is in scope

`010` and `040` both closed *adapter-side* routes to this shape: a truncated EOF
and a server cancel now raise typed errors, so those paths no longer reach the
buffered default. This phase closes the default itself, which is what makes the
guarantee hold for any adapter that ends a stream without a terminal — including
future ones nobody has audited.

## Scope warning

`src/bridge.ts` is shared by **every** provider. This phase therefore:

- changes only the no-terminal case, leaving every explicit `done`/`error`/
  `incomplete` path byte-identical;
- runs the **full** suite on `ssh lidge`, not the cursor subset. A baseline full
  run at `6d97442839` is captured before the change so any new failure is
  attributable.

## Contract

| Buffered turn | Status |
|---------------|--------|
| explicit `done` | `completed` — unchanged |
| explicit `error` | `failed` — unchanged |
| `incomplete` / `max_tokens` / `content_filter` | `incomplete` — unchanged |
| no terminal, no open tool call | `incomplete`, `incomplete_details.reason = "adapter_eof"` |
| no terminal, tool call left open | `incomplete`, and the item is **not** `completed` |

Streaming already reports `adapter_eof` for the fourth row (`bridge.ts:1283`), so
this aligns the buffered path with the streaming one rather than inventing a new
signal.

## Diff-level plan

**`src/bridge.ts`**

- In `buildResponseJSONWithBudget`, track whether any adapter terminal
  (`done`/`error`/`incomplete`) was observed.
- When none was, resolve `status` to `"incomplete"` with
  `incomplete_details: { reason: "adapter_eof" }`, matching the streaming path's
  wording exactly.
- An unclosed tool call must not carry item `status: "completed"`. Reuse the
  existing incomplete-item marking rather than adding a second notion of
  "unfinished".
- Do not touch `stopReason` handling, usage reporting, or compaction.

## Tests (`tests/bridge-nonstreaming-terminal.test.ts`)

1. Text with no terminal -> `incomplete` + `adapter_eof`, not `completed`. Red today.
2. Open tool call with truncated arguments and no `tool_call_end` -> turn is not
   `completed` and the item is not `completed`. Red today; this is the executable-
   garbage case.
3. Parity: the same events through streaming and buffered agree on terminal
   status. This is the assertion that keeps the two paths from drifting again.
4. Explicit `done` -> still `completed` (regression).
5. Explicit `error` -> still `failed`; explicit `incomplete` -> still `incomplete`
   with its own reason preserved (regression).

## Done when

All five pass, `bun run typecheck` clean, and the **full** suite on `ssh lidge`
matches the pre-change baseline. Tests 1 and 2 demonstrated red beforehand.

