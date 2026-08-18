# 015 — WP2b: the surviving EOF truncation error must carry partial usage

Origin: audit `r1` finding F3. This work-phase exists **because** `010` chose dev's
error-event shape; without it, choosing that shape would be a usage regression.

## The defect

Two paths report a truncated Cursor turn, and only one of them reports tokens.

| Path | Usage |
|------|-------|
| thrown transport failure | `attachPartialUsage` (`live-transport.ts:1195-1199`) → `cursor.ts:181-192` copies `partialUsage` into the error event | 
| `finalizeTurnEvents` open-tool branch | none (`protobuf-events.ts:1367-1372`) |

`CursorServerMessage`'s error variant already carries usage
(`src/adapters/cursor/types.ts:44-48`), and `resolvedTurnUsage(state)` is defined
in the same file at `:1340` and already used by the `done` branch at `:1376`. So the
omission is an oversight in the open-tool branch, not a design constraint.

Consequence: a turn that consumed real tokens and then truncated mid-tool-call
reports `usageStatus: unreported` with 0 tokens — the exact failure mode
`attachPartialUsage`'s own doc comment says it exists to prevent.

## MODIFY — `src/adapters/cursor/protobuf-events.ts`

In `finalizeTurnEvents`, the open-tool branch:

```diff
     for (const callId of openCallIds) state.translatorBudget?.closeCall(callId);
     state.openToolCalls.clear();
-    return [{ type: "error", message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.` }];
+    // Same usage resolution as the clean `done` branch below. A truncated turn still consumed
+    // tokens, and the error variant carries usage (types.ts CursorServerMessage). Without this the
+    // event-shaped truncation reports 0 tokens / unreported, while the thrown path reports real
+    // consumption via attachPartialUsage — so the choice of shape would change the bill.
+    return [{
+      type: "error",
+      message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.`,
+      usage: resolvedTurnUsage(state),
+    }];
```

`resolvedTurnUsage` is already in scope (same module).

### Check before writing: does the adapter overwrite it?

`src/adapters/cursor.ts:181-192` builds its error event from `err.partialUsage`.
That is the THROWN path and is unrelated to an event that already flowed through
the mapper. Confirm the mapper (`message-mapper.ts`) forwards `usage` on an error
message rather than dropping it; if it drops it, the mapper is the real fix site
and this doc gets amended at WP2b's P rather than patched blindly.

## TESTS — `tests/cursor-eof-terminal.test.ts`

Add a case, and drive it red first:

```ts
test("an EOF truncation error reports the tokens the turn already consumed", async () => {
  // A checkpoint/usage frame BEFORE the open tool call, then clean EOF with no terminal.
  // Red before the fix: usage is undefined on the error event.
  // ...arrange frames: assistant text with a token signal, toolCallStarted, then stream end
  expect(errorEvent.usage).toBeDefined();
  expect(errorEvent.usage?.outputTokens ?? 0).toBeGreaterThan(0);
});
```

The existing rewritten case from `010` asserts the SHAPE (error event, no `done`,
no `tool_call_end`); this new one asserts the USAGE. Keeping them separate means a
future change cannot quietly satisfy one by breaking the other — which is the
mistake the decode campaign already made once, when a test titled "carrying usage"
never asserted usage.

## Verification (C)

```
bun test tests/cursor-eof-terminal.test.ts tests/cursor-hardening.test.ts \
         tests/cursor-interaction-query.test.ts
bun x tsc --noEmit
```

`tests/cursor-interaction-query.test.ts:148-185` is in the list because it is the
existing contract for partial-usage reporting; this change must not disturb it.

