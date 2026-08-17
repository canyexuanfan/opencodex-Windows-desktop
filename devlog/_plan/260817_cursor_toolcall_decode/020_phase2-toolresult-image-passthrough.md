# 020 — Phase 2: tool-result image passthrough

Answers **F2** (`002`). Severity High. One PABCD cycle. Depends on `010` only by
branch order, not by logic.

## Problem restated

`contentToText` (`protobuf-request.ts:328`) replaces every image part of a tool
result with `[image input unsupported by Cursor adapter phase 3: ...]`, and
`toolResultPart` (`:384`) always emits a single `text` item — even though
`McpToolResultContentItem` has an `image` case (`gen/agent_pb.ts:8476`) and
`native-exec-mcp.ts:115` already constructs `McpImageContent` correctly for the
MCP path.

## Contract to establish

A tool result carrying images reaches Cursor as real image content on the native
path, and as an honest, compact description everywhere else.

1. **Native path** (`toolResultPart`): emit one `McpToolResultContentItem` per
   part, preserving order — `text` items for text, `image` items carrying decoded
   bytes and `mimeType` for images.
2. **External path** (`AssistantMessage` replay, lines 481-503): the wire has no
   image slot, so keep a placeholder — but a truthful one that states an image
   was produced and was not replayable, rather than "unsupported by phase 3".
3. **Decode**: reuse the existing base64 decoding helper from
   `native-exec-mcp.ts` rather than writing a second one. A part that cannot be
   decoded degrades to a placeholder; it never throws and never sends empty bytes.

## Bounding (mandatory, from `002`)

Real bytes make the blob and replay budgets load-bearing. This phase must:

- cap per-image bytes and total images per result, well under the 16 MiB blob
  admission limit (`native-exec.ts:81`), replacing anything over the cap with a
  placeholder naming the size;
- keep images out of the external replay-root text budget entirely, so an image
  can never consume the 512 KiB history allowance (`protobuf-request.ts:60`);
- prefer dropping the **oldest** images when several results carry them, since the
  most recent screenshot is the one the model is reasoning about.

## On the existing `wip/cursor-tool-result-text` draft

The branch `wip/cursor-tool-result-text` adds `tool-result-text.ts` with a
Computer-Use-specific text compactor: it keeps ~80 "interesting" AX lines matched
by a regex, and swaps the image placeholder for a shorter one.

**Judgment: reject the image half, reconsider the text half separately.** It
compacts the placeholder instead of sending the image, so it does not address F2
at all. Its text compaction is heuristic — a hardcoded regex over accessibility
output and a tool-name pattern (`/node_repl/i`) — and it discards real result
content on a guess. Once images pass through properly, the pressure that
motivated it largely disappears. If AX text volume is still a problem afterwards,
it earns its own unit with measurements. Do not land it as part of this phase.

## Diff-level plan

**`src/adapters/cursor/protobuf-request.ts`**

- Add `toolResultContentItems(message)` returning `McpToolResultContentItem[]`:
  map parts in order, text -> `McpTextContent`, image -> `McpImageContent` via the
  shared decoder, applying the caps above.
- `toolResultPart` uses that array instead of the single hardcoded text item.
- Keep `contentToText` for the external/text paths, with the placeholder reworded
  to state that an image was produced and omitted from replay.
- Preserve the existing `[tool_result]` envelope (`call_id`, `name`, `is_error`)
  in `toolResultToText`; only the image rendering changes.

**`src/adapters/cursor/native-exec-mcp.ts`**

- Export the base64 -> bytes helper (or lift it to a shared module) so both call
  sites decode identically. No behavior change on the MCP path.

## Tests (`tests/cursor-request-builder.test.ts` or a new `cursor-tool-result-image.test.ts`)

1. A tool result with one text and one image part produces two content items in
   order, the second being case `image` with the exact decoded bytes and mime type.
2. A string-content tool result still produces exactly one text item (regression).
3. An oversized image is replaced by a placeholder naming its size, and no
   oversized bytes reach the request.
4. An undecodable base64 payload degrades to a placeholder without throwing.
5. The external-model replay path emits no image bytes and keeps its text budget.

## Done when

All five pass, typecheck clean, cursor suite green on `ssh lidge`, pushed.
Evidence: exact command, output tail, pushed SHA.

