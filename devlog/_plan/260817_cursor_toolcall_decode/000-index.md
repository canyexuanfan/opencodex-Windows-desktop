# 260817 — Cursor tool-call decode and hardening

Unit goal: decode how the Cursor adapter encodes/decodes tool calls and tool
results, prove where information is lost or a turn dies mid-call, and land the
fixes the decode justifies.

Trigger: `cursor/grok-4.6` sessions running Computer Use / `node_repl` break
repeatedly — the turn dies mid tool call, the model loses the result, and the
session resets. This unit stops guessing and reads the wire.

## Document map

| Doc | Content |
|-----|---------|
| `001` | Tool-call lifecycle decode (`protobuf-events.ts`) |
| `002` | Tool-result encoding decode (`protobuf-request.ts`, `gen/agent_pb.ts`) |
| `003` | Transport terminal decode (`live-transport.ts`, `transport-retry.ts`) |
| `004` | External wire/format evidence (public reverse-engineering, vendor docs) |
| `010` | Phase 1 — gate the clean-EOF terminal (High) |
| `020` | Phase 2 — tool-result image passthrough (High) |
| `030` | Phase 3 — `xai/grok-4.6` does not use `apply_patch` |

## Findings summary

Three defects are proven by source reading, each with its own implementation
phase. Two hypotheses were **disproved** and are recorded as such, because a
decode that only confirms its own priors is not a decode.

| # | Defect | Severity | Phase |
|---|--------|----------|-------|
| F1 | A clean HTTP/2 EOF after >=1 frame settles the transport as success without `turnEnded`, so `finalizeTurnEvents` never runs and an open tool call vanishes. Non-streaming reports the truncated turn as `completed`. | High | `010` |
| F2 | Every image part of a tool result is replaced with placeholder text, even though the Cursor protobuf has a first-class `McpImageContent` case that the adapter already uses elsewhere. | High | `020` |
| F3 | `xai/grok-4.6` does not use `apply_patch`. | TBD (`030`) | `030` |

### Disproved hypotheses

- **"Open tool calls are silently dropped at finalize."** False. When a real
  `turnEnded` arrives, `finalizeTurnEvents` fails closed with an explicit
  incomplete-tool-call error (`protobuf-events.ts:1361`). The defect is not the
  finalizer; it is that a clean EOF never reaches it (F1).
- **"`maxClientToolCalls` / unknown-tool errors come from `commitToolCall`."**
  False. Both originate in `recordToolCall` (`protobuf-events.ts:1103`, `:1107`).
  `commitToolCall` only rejects invalid freeform and shell-bridge args.
- **"Tool-result text is unbounded and blows the request budget."** Partly false.
  There is no single whole-request cap, but external-model root replay is pruned
  to 192 roots / 512 KiB with UTF-8 truncation (`protobuf-request.ts:60,122`),
  and blobs are admitted under 16 MiB/entry and 64 MiB/store
  (`native-exec.ts:81`). Unbounded growth is bounded by pruning, not by failure.

## Execution contract (user-set)

- Branch `cursor-call`; push continuously with `--no-verify`; pushing pre-approved.
- CI verification explicitly waived by the user for this loop.
- Authoritative suite runs on `ssh lidge`, not the local workstation.
- Parallel subagents pre-approved: `gpt-5.6-sol` medium for code decode/audit,
  `gpt-5.6-luna` low for web discovery.
- One decade doc per implementation phase; one phase per PABCD cycle.

