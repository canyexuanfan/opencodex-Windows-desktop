# Phase 1 — Cursor conversation continuity across store:false requests

Owns RC1 (000_plan.md). Goal: every Responses request chained by
`previous_response_id` in one Codex task reuses the SAME `_cursorConversationId`,
so the carry-forward context cache hits and `done.usage.totalTokens` stays the
absolute conversation context.

## File change map

### MODIFY `src/server/responses.ts` — 4 call sites

Introduce one predicate near the top of the file (after imports, near other
small helpers):

```ts
// Adapters whose continuation state must survive Codex's store:false requests:
// their provider conversation ids (kiro, cursor) only live in the proxy-internal
// continuation cache, and losing them breaks tool continuation (kiro) and
// absolute context carry-forward (cursor).
function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}
```

Then replace each ternary:

Before (`:1537`, streaming routed):
```ts
                adapter.name === "kiro" ? { force: true } : undefined,
```
After:
```ts
                adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
```

Same one-line replacement at `:1574` (non-streaming routed, `adapter.name`),
`:1824` (generic streaming, `activeAdapter.name`), `:1859` (generic
non-streaming, `activeAdapter.name`).

No change to `rememberResponseState()` itself (`src/responses/state.ts:182`):
its `force` bypasses only the store:false skip; status/id/output checks stay.
Storage remains the bounded in-memory + disk continuation cache
(`MAX_STORED_RESPONSES`, 1h TTL) — not real server-side storage. Compaction
turns already skip `rememberResponseState` entirely (routedCompaction guard),
so the stale-chain hazard is unchanged.

## Why not force for every adapter

Continuation items replay full input on expansion; adapters that are stateless
per request (plain HTTP providers) don't need the cache, and forcing globally
would grow the store for no benefit. Only kiro/cursor carry provider-side
conversation ids in continuation state today (see `OcxProviderContinuationState`).

## Accept criteria

1. A Cursor request with `store:false` that completes → its response id is
   expandable: `previousResponseProviderState(id)?.cursor?.conversationId` equals
   the conversation id the adapter used.
2. Follow-up request with `previous_response_id` → `parsed._cursorConversationId`
   restored (`src/server/responses.ts:963`) → `createCursorRequest` keeps it
   (`src/adapters/cursor/request-builder.ts:195`).
3. Kiro behavior byte-identical.
4. Activation scenario (C-ACTIVATION-GROUNDING-01): new regression test drives a
   store:false Cursor-shaped rememberResponseState call through the SAME force
   policy used at the call sites and asserts the state is retained; a control
   case with a non-forced adapter name stays skipped.

## Tests

### MODIFY `tests/responses-state.test.ts`

Next to "force records Kiro provider continuation despite store:false" (`:123`):

```ts
test("force records Cursor provider continuation despite store:false", () => {
  const firstBody = { model: "cursor/grok-4.5", input: "hello", store: false };
  const first = responseFixture("resp_cur_1", [assistantMessage("hi")], "cursor/grok-4.5");
  rememberResponseState(firstBody, first, { cursor: { conversationId: "cursor_conv_1" } }, { force: true });
  expect(previousResponseProviderState("resp_cur_1")).toEqual({
    cursor: { conversationId: "cursor_conv_1" },
  });
});
```

(Exact fixture helper names to be matched to the file's existing helpers at B
time — the suite already builds kiro fixtures the same way.)

Plus a policy-level test for the predicate if it is exported; if kept private,
cover through the existing responses-server integration suite that exercises a
routed cursor adapter completion (check `tests/` for the current server-level
harness; if none reaches `rememberResponseState`, export the predicate and
unit-test it directly — smallest honest surface).

## Verification

```
bun run typecheck
bun test tests/responses-state.test.ts tests/cursor-request-builder.test.ts tests/cursor-protobuf-events.test.ts
```
