# 080 — #1830 / PR #1832: supply the evidence the fix is missing

PR #1832 head `4424138a3`, non-draft, exact-head CI green, both review threads resolved. The change itself is plausible; the evidence is thin.

## What the PR does

Four things only: `normalizeRoutedCatalogEntry` sets `supports_search_tool = true` for Cursor while still deleting hosted-search metadata (`src/codex/catalog/parsing.ts:458-473`), `deriveEntry` gives template-less Cursor rows the same flag (`src/codex/catalog/sync.ts:360-369`), a structure doc update, and tests that assert only `tool_mode` / `supports_search_tool` / `web_search_tool_type` / parallel calls.

## The gap

Nothing at that head builds the ACTUAL advertised Cursor tool catalog, serializes it, and proves it still fits. The machinery exists but is unconnected:

- `CURSOR_TOOL_BYTES_LIMIT = 120_000` and `applyCursorToolBudget(tools, toolChoice)` measure real protobuf size (`src/adapters/cursor/request-builder.ts:29`, `:65`).
- `cursorMcpToolsEncodedSize(...)` serializes `McpToolsSchema` via `toBinary` (`src/adapters/cursor/tool-definitions.ts:684`).
- Existing budget tests use hand-built `exec`/`wait` fixtures (`tests/cursor-request-builder.test.ts:458`, `:486`), not the catalog this PR changes.

So the PR could pass while the real catalog either exceeds the budget or drops the execution bridge — which is exactly `#1830`'s symptom.

## Required test

Build the advertised catalog the way a real Cursor-routed subagent turn does, run it through `applyCursorToolBudget`, and assert:

1. serialized size `<= CURSOR_TOOL_BYTES_LIMIT`;
2. a Responses-owned execution tool survives the budget — `exec` (or the bridge equivalent) is still present;
3. `wait` is still present;
4. the search flag this PR sets is on the entry that actually reaches the wire.

Assert against the SERIALIZED form, not the pre-budget array, or the test proves nothing about what the child receives.

## Close-out

`#1830`'s stated acceptance is broader than the byte budget: it wants a Responses-owned execution client tool injected or preserved, and explicitly does NOT want users globally enabling Cursor-native local execution (the maintainer comment narrows it to retaining the Responses-owned path). Merge #1832 with the serialization test; close `#1830` only if a fresh Cursor child demonstrably performs a read-only task through a host-recognized exec path. If that live check cannot be run, keep `#1830` open and say so — the byte test alone is not the acceptance condition.
