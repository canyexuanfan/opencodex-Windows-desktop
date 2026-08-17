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

Two defects are proven by source reading; a third is a proven *lossy
conversion* whose behavioral consequence is explicitly unproven. Each gets its
own implementation phase. Two hypotheses were **disproved** and are recorded as such, because a
decode that only confirms its own priors is not a decode.

| # | Defect | Severity | Phase |
|---|--------|----------|-------|
| F1 | A clean HTTP/2 EOF after >=1 frame settles the transport as success without `turnEnded`, so `finalizeTurnEvents` never runs and an open tool call vanishes. Non-streaming reports the truncated turn as `completed`. | High | `010` |
| F2 | Every image part of a tool result is replaced with placeholder text, even though the Cursor protobuf has a first-class `McpImageContent` case that the adapter already uses elsewhere. | High | `020` |
| F3 | On the `xai` path the freeform `apply_patch` contract is erased (`parser.ts:184`, `openai-chat.ts:1194`). The conversion is provably lossy; that this is *why* grok-4.6 avoids the tool is **not proven** — per-property guidance already exists (`parser.ts:189`). `030` is an experiment, not a fix. | lossy conversion proven; **symptom did not reproduce** in a live probe — see 030 | `030` |

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


## Audit trail

The first draft of this unit was submitted to an adversarial `gpt-5.6-sol`
reviewer instructed to falsify it. It returned **FAIL with ten findings**, all of
which were re-verified against source before being accepted. The unit was
corrected rather than defended:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `001` put arg buffering on `toolCallDelta`; it happens on `partialToolCall` (`protobuf-events.ts:1254`) | table corrected |
| 2 | `003` presented two terminal rows as unconditional; both are `expectedClose`-conditional | table corrected |
| 3 | `010` claimed a typed error makes the turn retryable; `committed` is set on HTTP/2 `connect` (`live-transport.ts:780`) so `canRetry` can never be true | claim withdrawn, retry test removed |
| 4 | `010` wanted `finalizeTurnEvents` **and** `settleFail`, producing a double terminal | transport named sole terminal owner |
| 5 | `010` equated `state.terminated` with a real `turnEnded`; the synthetic client-tool finalize also sets it (`:386`, `:750`) | meaning corrected, test 4 added |
| 6 | `002` claimed image loss is the direct cause of resets; no live trace supports it | causal claim withdrawn |
| 7 | `020` planned to reuse the MCP base64 decoder; `OcxImageContent` carries a `data:` or remote URL (`types.ts:156`) | data-URL parser specified, remote URLs scoped out |
| 8 | `020`'s per-image cap cannot bound one `ConversationStep`, which is stored as a single blob | conversation-level byte budget, newest-first |
| 9 | `030` claimed Grok gets no apply_patch guidance; `parser.ts:189` already attaches per-property guidance | root cause downgraded to "lossy conversion, cause unproven" |
| 10 | `030`'s guidance would fire for every `openai-chat` provider and could demote a sibling edit tool | xai-scoping attempted; round 2 finding 1 then showed the identity seam does not exist, and finding 3 showed the sibling predicate is undefinable — see the round 2 table |

Findings 3, 4, 5, 9, and 10 were load-bearing: acting on the original plan would
have produced a double-terminal bug, a test that could never pass, and a prompt
change leaking into unrelated providers.

## Open follow-ups (deliberately not in this unit)

- **Non-streaming reports a terminal-less turn as `completed`** (`bridge.ts:1829`).
  Real, but fixing it needs evidence about whether Cursor ever legitimately ends
  a stream without `turnEnded`; a wrong guess fails healthy turns. Not smuggled
  into `010`.
- **User-message images are placeholdered** (`request-builder.ts:201`,
  `protobuf-request.ts:314`) although `SelectedImage` supports blob/inline data.
  Separate capability, separate unit.

### Round 2

The corrected unit was submitted to a second independent adversarial reviewer,
which confirmed the `001`/`003` corrections and found `010` coherent,
regression-free, and implementable — then returned **FAIL with seven further
findings** on the other documents:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `030`'s xai-only gate is not implementable where it was placed: the adapter factory never receives a provider name (`adapters/registry.ts:15-17`, `server/adapter-resolve.ts:51-52`) | threading provider identity is now declared in-scope for `030`; its isolation test must use the **same base URL** so host sniffing cannot fake a pass |
| 2 | `020`'s decoded-byte budget still cannot bound a serialized `ConversationStep`, so a near-limit text result plus an image could newly fail | bounding moved **after** serialization: measure, degrade images, re-serialize; added a near-limit regression test and a byte-identical no-image test |
| 3 | "sibling edit-capable tool" has no decidable predicate (`types.ts:206-224`, `tool-catalog-nudge.ts:12-17`) | gate dropped; the note now describes call shape instead of claiming exclusivity, so no predicate is needed |
| 4 | `020` would tighten `parseDataUrl`, which Anthropic, Google, and Command Code share (`adapters/image.ts:8`) | a new strict helper is layered **on top of** the shared parser; the shared contract is untouched |
| 5 | `030` misstated xAI support: custom function calling is demonstrated via `/v1/responses`, and object-root schemas are still required | corrected; option 3 must also distinguish the API-key surface from the OAuth CLI proxy |
| 6 | `000` overstated F3 as proven and recorded xai isolation as resolved | F3 downgraded above; the round-1 row now points at findings 1 and 3 |
| 7 | `004` conflates Connect end-stream framing with gRPC-web trailers | terminology corrected in `004`; the sources are kept as protocol-principle context, not as claims about this transport |

Round 2 mattered most where it was least comfortable: findings 1 and 2 each
showed a *correction* from round 1 was itself unimplementable. That is the
argument for auditing revisions rather than only first drafts.

### Round 3

A third reviewer confirmed that F3 is now stated honestly and that `004`'s
Connect/gRPC-web disambiguation is correct, then returned **FAIL with five
findings** — every one a refinement of a round-2 correction:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `020` never wires its degrade loop to the real limit authority; `BLOB_MAX_ENTRY_BYTES` is private and test-overridable (`native-exec.ts:91`, `:122-126`) | the effective limit is exported and passed, so the degrade loop and admission cannot drift |
| 2 | `030`'s identity seam covered one construction site; adapters are rebuilt on retry/rotation (`core.ts:584` and seven more) | identity is mandatory at the route-resolver boundary; a reconstruction test is added |
| 3 | Same-base-URL isolation does not prove identity gating; auth mode or headers could discriminate | the isolation test now uses an identical `OcxProviderConfig`, varying only identity |
| 4 | "cannot demote a sibling tool" is an unsupported behavioral claim | wording shape specified (conditional, never "prefer"); residual risk recorded as live-test-dependent, not disproved |
| 5 | The xAI paragraph was still too absolute | restated as a claim about the *documented contract*; object root or `anyOf`/`oneOf` branches are permitted |

Also folded: test 8's byte-identical comparison must freeze `crypto.randomUUID()`
(`protobuf-request.ts:509`, `:592`) or compare deterministic nested step bytes.

The finding count fell 10 -> 7 -> 5 and the severity fell with it: round 3 found
no unimplementable design, only under-specified ones. `010` has now been judged
coherent, regression-free, and implementable by two independent reviewers.
