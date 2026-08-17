# 020 — Phase 2: tool-result image passthrough

Answers **F2** (`002`). Severity High. One PABCD cycle.
**Revised after an adversarial audit returned FAIL** (findings 7, 8).

## Problem restated

`contentToText` (`protobuf-request.ts:328`) replaces every image part of a tool
result with `[image input unsupported by Cursor adapter phase 3: ...]`, and
`toolResultPart` (`:384`) always emits a single `text` item — although
`McpToolResultContentItem` has an `image` case (`gen/agent_pb.ts:8476`) carrying
`data: Uint8Array` and `mimeType`.

## The source format is a URL, not base64 (audit correction)

The original plan proposed reusing the MCP decoder from `native-exec-mcp.ts:115`.
**Wrong contract.** That helper takes bare base64 plus a separate `mimeType`,
which is the MCP block shape. A Codex tool result carries `OcxImageContent` with
a single `imageUrl` field that is *either* a `data:` URL *or* a remote `https`
URL (`types.ts:156`). Reusing the MCP helper would mis-decode data URLs and
cannot represent a remote URL at all.

This phase therefore needs a `data:` URL parser, not a base64 decoder:

- parse the `data:<mime>;base64,<payload>` form, taking `mimeType` from the URL
  itself rather than a sibling field;
- **remote `https` URLs are out of scope** — Cursor's `McpImageContent` takes
  bytes, and fetching a remote image inside request construction would add
  network IO to a pure encoding path. Remote URLs keep a placeholder that says so.
- validate strictly: `Buffer.from(x, "base64")` accepts many invalid strings
  silently, so a malformed payload must be detected by validating the base64
  charset and decoded length before use, not by trusting the decoder to throw.
- check `src/adapters/image.ts` first (`:8`) — if a data-URL parser already
  exists there, extend it instead of adding a second one.

## Bounding must be conversation-level (audit correction)

The original per-image cap was insufficient. `protobuf-request.ts:362` serializes
the whole `ConversationStep` — text, every image, and the envelope — into **one**
blob, and admission caps a single blob at 16 MiB (`native-exec.ts:91`). Several
in-budget images can therefore still overflow one step, and a per-message helper
cannot see across results to drop the oldest.

The bound must be applied where the conversation is assembled, not inside the
per-message mapper:

- a total decoded-image byte budget for the request, tracked in
  `conversationTurns` as steps are built;
- newest-first allocation: walk results from most recent backwards, admitting
  images while budget remains, so the screenshot the model is currently reasoning
  about survives and older ones degrade to placeholders;
- a per-image ceiling as a cheap pre-filter, well under the step budget;
- images never enter the external replay-root text budget (`:60`, `:122`).

## The three result paths

Native-with-matching-call (lines 493-496) gains real image content. The external
replay path (481-490) and the unmatched-native path (498-503) keep a placeholder,
reworded to state that an image was produced and omitted, rather than the current
"unsupported by Cursor adapter phase 3".

## On the `wip/cursor-tool-result-text` draft

Reject for this phase. It compacts the *placeholder* rather than sending the
image, so it does not address F2, and its text compaction is a hardcoded regex
over accessibility output that discards real content on a guess. If AX text
volume still hurts after images pass through, it earns its own unit with
measurements.

## Diff-level plan

**`src/adapters/cursor/protobuf-request.ts`**

- Add `toolResultContentItems(message, budget)` returning
  `McpToolResultContentItem[]`: map parts in order; text -> `McpTextContent`;
  image -> `McpImageContent` when the data URL parses, validates, and fits the
  remaining budget; otherwise a placeholder text item naming why.
- `toolResultPart` takes the budget and uses that array.
- `conversationTurns` owns the budget object and allocates newest-first.
- Keep `contentToText` for text-only paths with the reworded placeholder.
- Preserve the `[tool_result]` envelope (`call_id`, `name`, `is_error`).

## Tests (`tests/cursor-tool-result-image.test.ts`)

1. A result with one text and one `data:` image part produces two items in order,
   the second case `image` with exact decoded bytes and the mime from the URL.
2. A string-content result still produces exactly one text item (regression).
3. A remote `https` image URL produces a placeholder and no bytes.
4. A malformed base64 payload produces a placeholder and does not throw.
5. Images across several results are admitted newest-first until the budget is
   exhausted; older ones become placeholders.
6. A single oversized image is rejected by the per-image ceiling.
7. The external replay path emits no image bytes and keeps its text budget.

## Done when

All seven pass, typecheck clean, cursor suite green on `ssh lidge`, pushed.

