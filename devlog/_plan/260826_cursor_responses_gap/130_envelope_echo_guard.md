# 130 — gap-10: external replay [Tool Result] envelope echo priming

## Symptom

Live probe (dev head 58f5a294e, service :10100, 2026-08-26): multi-round tool-call
replay probe (`/tmp/ocx_qa/replay_probe.py`) against `cursor/kimi-k3-1m`,
7 total runs. 2 runs failed the same way: instead of issuing the next
`run_cmd` call, the model emitted the replay envelope as its OWN text:

```
[Tool Result]
[tool_result]
call_id: run_cmd_0_9c0e7f7a-3e3e3
name: run_cmd
is_error: false
output:
R1=...
```

`cursor/grok-4.6` passed the same probe consistently (no echo observed).

## Root cause

External full-replay flattens tool results into assistant-role
"[Tool Result]\n[tool_result]\ncall_id: ..." text (needed so Cursor does not
wrap them as `<user_query>`, #1992). After a few rounds the transcript
contains N such assistant-role blocks, and a mimicking model treats the
envelope as an expected assistant output format — the same few-shot priming
mechanism as the gap-9 repetition loop, but for the envelope itself.

## Fix

`rootPromptMessages` appends ONE user-role context note
(`CURSOR_TOOL_RESULT_ENVELOPE_GUARD_NOTE`) after history replay whenever at
least one tool result was replayed for an external model: the markers are
environment-generated, never begin a reply with them, respond with your own
words or the next tool call.

## Verification

- `tests/cursor-envelope-echo-guard.test.ts`: guard appended exactly once and
  positioned after the replayed tool-result entry; absent when no tool results.
- Live re-probe after service repair: kimi-k3-1m replay probe rerun batch.

## Non-adapter residual (recorded, not fixed here)

1 of 7 runs failed differently: R1 answered "STATE A17" without issuing the
tool call first (premature final on a fresh conversation with zero replay
history). That is model nondeterminism on instruction-following, not a replay
artifact; no adapter change targets it.
