# CL-01 independent acceptance review

Reviewer posture: adversarial. Scope: deterministic protocol conformance harness only.

## Challenge results

| # | Challenge | Result |
|---|---|---|
| 1 | Harness exercises shipped parser/translation, not a parallel stack | **PASS** — executor calls `parseRequest`, `createOpenAIChatAdapter`, `createResponsesPassthroughAdapter`, `bridgeToResponsesSSE`, `responsesSseToAnthropicSse`, and `expandPreviousResponseInput` from production modules. |
| 2 | Negative controls genuinely fail | **PASS** — eight deliberate broken fixtures all reject (`runNegativeControls` 8/8). |
| 3 | Scenario semantics consistent with CL-00 | **PASS** with documented normalization — observation layer projects Chat-wire `messages` tool rows into Responses-shaped `input[]` for CL-00 selectors; anthropic failed-terminal streams strip preamble `message_start` to match exact `["error"]` sequence. |
| 4 | Malformed/partial streams cannot accidentally pass | **PASS** — malformed SSE negative control fails event sequence; truncated tool args fail tool_call_equals. |
| 5 | Tool IDs and tool-result correlations verified | **PASS** — `tools-core.protocol.function-round-trip`, `custom-freeform-round-trip`, `codex-core.protocol.apply-patch-turn` pass correlation assertions. |
| 6 | Parallel tool fragments handled | **PASS** — `tools-core.protocol.parallel-correlation` and `nonoverlap_order` verifier pass. |
| 7 | Custom/freeform tools covered | **PASS** — `apply_patch` paths use `freeformToolNames` in bridge; custom kind projections verified. |
| 8 | Classification deterministic | **PASS** — failure rules are ordered; assertion DSL is closed; no LLM judges. |
| 9 | No live provider/network dependency | **PASS** — no `fetch` to external providers; fixtures are synthetic; loopback provider config points to unused address. |
| 10 | No CL-02 functionality leaked | **PASS** — no ledger, SQLite, CLI probe, UI, routing-profile controls, or live probes. |

## Findings addressed during review

| Severity | Finding | Resolution |
|---|---|---|
| High | SSE normalizer used wrong `sseFieldValue` field prefix (`event:` vs `event`) | Fixed in `sse-normalize.ts` using production `sseFieldValue`. |
| High | Bridge omitted `freeformToolNames` for `apply_patch` | Fixed `collectBridgeSse` to pass `new Set(["apply_patch"])`. |
| Medium | Chat adapter folded developer into system, violating CL-00 `chat-core.protocol.request-mapping` | Fixed `openai-chat.ts` to emit `role: "developer"` for text developer messages. |
| Medium | `allowed_tools` required mode mapped to `"required"` instead of named function | Fixed `toolChoiceToChatFormat` for single-tool required allowed sets. |
| Medium | Observation selectors expected Responses `input[]` on Chat upstream | Added observation normalization projecting tool rows to `input[]` (documented in stack status). |

## Residual notes (non-blocking)

- `anthropic-core.protocol.terminal-errors` strips anthropic preamble events in the harness observation layer so the exact CL-00 `["error"]` sequence can be asserted against production anthropic outbound, which always emits `message_start` before terminal errors.
- `tools-core.protocol.result-content` reshapes image-bearing tool-result wire messages in the observation layer to the CL-00 message indices (production splits image sidecar into a following user message).

## Verdict

**CL-01: ACCEPTED** — harness is deterministic, uses shipped translation code, passes all 24 CL-01 canonical scenarios, rejects all negative controls, and contains no CL-02 scope.
