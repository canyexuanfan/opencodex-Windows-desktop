# 010 — Cycle 1: passthrough record/replay state machine (#334 + #326)

> DIFFLEVEL-ROADMAP-01: this is the copy-paste-executable implementation PRD for Cycle 1. The implementer must keep the production and test paths, signatures, branch semantics, and verification gates below unless new repository evidence makes the design impossible. Any expansion is escalated to the main agent before editing.

## Loop spec

- **Loop archetype:** spec-satisfaction repair.
- **Trigger:** issue #334 reports that native Responses SSE persistence loses completed output items when `response.completed.response.output` is absent or empty; issue #326 reports that proxy-generated multi-agent guidance is persisted and then appended again on every `previous_response_id` continuation.
- **Goal:** make passthrough continuation recording reconstruct terminal output from `response.output_item.done` events when necessary, and make proxy-generated guidance injection idempotent across replayed prefixes, without altering client-facing SSE bytes or compaction ordering.
- **Non-goals:** redesign the Responses state store; strip guidance at persistence time; merge the inspection and metadata consumer loops; backfill request-log-only SSE tracking; synthesize items from delta events; change upstream payloads, adapter routing, provider continuation state, retention limits, snapshots, compaction behavior, or GUI/docs behavior.
- **Verifier:** `bun run typecheck`; `bun run test`; `bun run privacy:scan`.
- **Stop condition:** all focused regressions below pass, all three repository verifiers exit 0, native client SSE remains byte-identical, empty/missing terminal output is backfilled in `output_index` order for both persistence-capable consumers, non-empty terminal output remains authoritative, and a two-continuation replay contains exactly one proxy guidance item in outbound input and persisted state.
- **Memory artifact:** this file, `devlog/_plan/260724_bugfix_train/010_passthrough_state.md`, updated only by the owning main agent if implementation evidence forces a correction.
- **Expected terminal outcomes:** `PASS` (implementation and all verifiers satisfy this spec); `FAIL` (a verifier or acceptance assertion fails and the cycle returns to implementation); `BLOCKED` (the required behavior cannot be achieved inside the file/scope map and is escalated).
- **Escalation:** upward — main reclaims after two agent failures; downward — none planned.

## Failure model and invariants

### #334 — terminal response is not the whole streamed response

`src/server/relay.ts` currently extracts only the `response` object carried by `response.completed`. Native Responses streams can instead finalize authoritative output items in earlier `response.output_item.done` events while the terminal event has `output: []` or no `output`. `rememberResponseState` accepts any array, including an empty one, so the current terminal-only callback either stores no assistant/reasoning/function-call items or does not store at all when `output` is absent. The next locally expanded continuation is therefore incomplete and can repeat a tool call forever.

The repair law is:

1. Observe only `response.output_item.done` events.
2. Store each valid item in one `Map<number, unknown>` keyed by integer, non-negative `output_index`; later observations for the same index replace earlier ones.
3. On `response.completed`, leave a non-empty terminal `response.output` exactly untouched.
4. If terminal `output` is missing or an empty array and at least one done item was accumulated, provide a shallow response copy whose `output` is the accumulated items sorted by ascending index.
5. Invoke `onCompletedResponse` only after rule 3 or 4 has been applied.
6. Never rewrite, buffer, re-encode, or emit the client-facing SSE branch.

The two persistence-capable consumers deliberately keep different control loops:

- `consumeForInspection` stops inspecting post-terminal payloads only when there is no completion callback (`if (reported && !onCompletedResponse) continue`). Preserve that condition and route each payload that remains eligible through the accumulator.
- `consumeForResponseLogMetadata` never applies that skip. Preserve its loop and route every parsed payload through the same accumulator.
- `trackSseForRequestLog` is terminal-status/request-log tracking only. It has no `onCompletedResponse`, never calls `rememberResponseState`, and must not allocate or use the item accumulator. It needs no backfill.

### #326 — replay provenance must reach injection

`expandPreviousResponseInput` already records the replay prefix length in a proxy-private `WeakMap` keyed by the exact expanded request object. `parseRequest` reads that length for compaction-boundary logic, but discards it from `OcxParsedRequest`. `injectDeveloperMessage` therefore cannot distinguish replayed proxy guidance from a new request suffix and always appends another copy to both parsed messages and `_rawBody.input`. Passthrough persistence records the mutated `_rawBody`, producing one extra guidance item per continuation.

The repair law is:

1. Add optional proxy-private `OcxParsedRequest._replayPrefixLen?: number`.
2. `parseRequest` copies its already-read `replayedInputPrefixLength` into that field when the value is positive.
3. `injectDeveloperMessage` constructs the exact wire item it would inject, scans every item in `_rawBody.input.slice(0, _replayPrefixLen)`, and skips both parsed-message and raw-input insertion if an exact generated item is present.
4. “Exact generated item” means `{type:"message", role:"developer", content:[{type:"input_text", text}]}` with exactly one content part and the exact requested text. Do not match arbitrary developer messages, substrings, or suffix items.
5. Detection searches the whole replay prefix. It never assumes guidance is first, last, adjacent to a user item, or adjacent to `compaction_trigger`.
6. Fresh insertion retains the existing invariant: if the final raw item is `compaction_trigger`, insert immediately before it; otherwise append.
7. Do not implement the rejected persist-time stripping alternative. It would spread policy across five persistence call sites and enlarge the blast radius.

## Exact file change map

### Planning artifact changes for this cycle

- **NEW** `devlog/_plan/260724_bugfix_train/010_passthrough_state.md` — this diff-level implementation contract.
- **DELETE** `devlog/_plan/260724_bugfix_train/010_phase1.md` — superseded empty scaffold.

### Production and regression changes to implement

- **MODIFY** `src/server/relay.ts` — add one shared stateful completion accumulator and use it from `consumeForInspection` and `consumeForResponseLogMetadata`; retain `completedResponseFromSsePayload` and leave `trackSseForRequestLog` unchanged.
- **MODIFY** `src/types.ts` — add `_replayPrefixLen?: number` to `OcxParsedRequest`.
- **MODIFY** `src/responses/parser.ts` — preserve the already-computed replay prefix length on the parsed request.
- **MODIFY** `src/server/responses/collaboration.ts` — detect the exact generated guidance item anywhere in the replay prefix and make dual-write injection idempotent.
- **MODIFY** `tests/responses-state.test.ts` — add focused stream/persistence tests for both relay consumers, terminal-output authority, and the two-continuation guidance regression.

No other file is part of Cycle 1. In particular, do not modify `src/server/responses/core.ts`, `src/responses/state.ts`, `src/server/request-log.ts`, adapters, snapshots, docs, GUI, workflows, dependencies, or release automation.

## Diff-level implementation

### 1. `src/server/relay.ts`

#### Keep the terminal extractor signature unchanged

Current code:

```ts
/** Extract the response object from a `response.completed` SSE payload, or null. */
export function completedResponseFromSsePayload(payload: string): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown; response?: unknown };
    if (json.type !== "response.completed") return null;
    const response = json.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    return response as { id?: unknown; output?: unknown; status?: unknown };
  } catch {
    return null;
  }
}
```

After: retain this function byte-for-byte. Add the following immediately after it. The new helper is file-private because only the two background consumers own this reconstruction responsibility.

```ts
type CompletedResponse = { id?: unknown; output?: unknown; status?: unknown };

function createCompletedResponseAccumulator(
  onCompletedResponse?: (response: CompletedResponse) => void,
): (payload: string | null) => void {
  const itemsByOutputIndex = new Map<number, unknown>();
  return payload => {
    if (!payload || payload === "[DONE]") return;
    try {
      const event = JSON.parse(payload) as {
        type?: unknown;
        output_index?: unknown;
        item?: unknown;
      };
      if (event.type === "response.output_item.done") {
        if (Number.isInteger(event.output_index)
          && (event.output_index as number) >= 0
          && event.item !== undefined) {
          itemsByOutputIndex.set(event.output_index as number, event.item);
        }
        return;
      }
    } catch {
      return;
    }

    let response = completedResponseFromSsePayload(payload);
    if (!response) return;
    if ((!Array.isArray(response.output) || response.output.length === 0)
      && itemsByOutputIndex.size > 0) {
      response = {
        ...response,
        output: [...itemsByOutputIndex.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item),
      };
    }
    onCompletedResponse?.(response);
  };
}
```

Implementation note: the first parse handles item-done observation; non-item events then flow to the existing terminal extractor. A malformed payload remains best-effort/no-throw. Do not export this helper and do not broaden `CompletedResponse` beyond the existing callback contract.

#### Modify `consumeForInspection`

Real signature (unchanged):

```ts
export function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus, httpStatusOverride?: number) => void,
  signal?: AbortSignal,
  onDone?: () => void,
  logCtx?: RequestLogContext,
  onCancel?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
): void {
```

Current initialization:

```ts
  let reported = false;
  let cancelled = false;
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
```

After:

```ts
  let reported = false;
  let cancelled = false;
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
  const observeCompletedResponse = createCompletedResponseAccumulator(onCompletedResponse);
```

Current EOF completion block:

```ts
              if (onCompletedResponse) {
                const response = completedResponseFromSsePayload(payload);
                if (response) onCompletedResponse(response);
              }
```

After:

```ts
              observeCompletedResponse(payload);
```

Current normal-loop completion block:

```ts
          if (onCompletedResponse) {
            const response = completedResponseFromSsePayload(payload);
            if (response) onCompletedResponse(response);
          }
```

After:

```ts
          observeCompletedResponse(payload);
```

Do not alter `if (reported && !onCompletedResponse) continue`, terminal reporting, logging, first-output reporting, cancellation, synthetic status behavior, or `onDone` ordering. The accumulator runs only on payloads the existing loop already permits. The normal event ordering (`output_item.done` before `response.completed`) guarantees backfill is complete before the callback.

#### Modify `consumeForResponseLogMetadata`

Real signature (unchanged):

```ts
export function consumeForResponseLogMetadata(
  body: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  signal?: AbortSignal,
  onDone?: () => void,
  onCompletedResponse?: (response: { id?: unknown; output?: unknown; status?: unknown }) => void,
  onFirstOutput?: () => void,
): void {
```

Current initialization:

```ts
  let buffer = "";
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
```

After:

```ts
  let buffer = "";
  const reportFirstOutput = createFirstOutputReporter(onFirstOutput);
  const observeCompletedResponse = createCompletedResponseAccumulator(onCompletedResponse);
```

Replace both identical callback blocks (one in EOF residual handling, one in the normal block loop):

```ts
            if (payload && onCompletedResponse) {
              const response = completedResponseFromSsePayload(payload);
              if (response) onCompletedResponse(response);
            }
```

and

```ts
          if (payload && onCompletedResponse) {
            const response = completedResponseFromSsePayload(payload);
            if (response) onCompletedResponse(response);
          }
```

with, respectively:

```ts
            observeCompletedResponse(payload);
```

and

```ts
          observeCompletedResponse(payload);
```

Do not add a reported/terminal skip to this consumer. It must continue inspecting every payload for request-log metadata exactly as before.

#### Explicit no-change: `trackSseForRequestLog`

Real signature:

```ts
export function trackSseForRequestLog(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  onCancel: () => void,
  logCtx?: RequestLogContext,
  onFirstOutput?: () => void,
): ReadableStream<Uint8Array> {
```

Before and after are identical. This function only calls `terminalStatusFromSsePayload`, reports log terminal state, and relays bytes. It has no response-state callback. Adding the accumulator here would create unused state and blur the persistence boundary.

### 2. `src/types.ts`

Current excerpt:

```ts
export interface OcxParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /** True when the proxy expanded a previous_response_id request into a full input replay. */
  _previousResponseInputExpanded?: boolean;
```

After:

```ts
export interface OcxParsedRequest {
  modelId: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /** Number of leading raw input items restored from local previous_response_id state. */
  _replayPrefixLen?: number;
  /** True when the proxy expanded a previous_response_id request into a full input replay. */
  _previousResponseInputExpanded?: boolean;
```

Keep the field optional so existing hand-built `OcxParsedRequest` fixtures remain valid. It is proxy-private metadata and must never be serialized into `_rawBody` or sent upstream.

### 3. `src/responses/parser.ts`

Real signature:

```ts
export function parseRequest(body: unknown): OcxParsedRequest {
```

Current opening already captures provenance and remains unchanged:

```ts
export function parseRequest(body: unknown): OcxParsedRequest {
  const replayedInputPrefixLength = previousResponseReplayPrefixLength(body);
  const parsed = responsesRequestSchema.safeParse(body);
```

Current return excerpt:

```ts
  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(webSearch ? { _webSearch: webSearch } : {}),
```

After:

```ts
  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(replayedInputPrefixLength > 0 ? { _replayPrefixLen: replayedInputPrefixLength } : {}),
    ...(webSearch ? { _webSearch: webSearch } : {}),
```

Do not replace the existing `WeakMap`, add a wire field, or change the existing `inputIndex >= replayedInputPrefixLength` compaction-boundary test. This is a second consumer of the provenance already read at function entry.

### 4. `src/server/responses/collaboration.ts`

#### Add exact-item predicates immediately above `injectDeveloperMessage`

After:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGeneratedDeveloperItem(item: unknown, text: string): boolean {
  if (!isRecord(item) || item.type !== "message" || item.role !== "developer") return false;
  if (!Array.isArray(item.content) || item.content.length !== 1) return false;
  const [part] = item.content;
  return isRecord(part) && part.type === "input_text" && part.text === text;
}
```

If this file already has an equivalent record guard at implementation time, reuse it instead of adding a duplicate. The semantic check must remain exact as shown.

#### Modify `injectDeveloperMessage`

Real signature:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
```

Current function:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  if (raw && Array.isArray(raw.input)) {
    const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}
```

After:

```ts
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
  if (raw && Array.isArray(raw.input)) {
    const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, raw.input.length);
    if (raw.input.slice(0, replayPrefixLen).some(item => isGeneratedDeveloperItem(item, text))) {
      return;
    }
  }

  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  if (raw && Array.isArray(raw.input)) {
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}
```

The early return is intentionally before the parsed-message push. `parseRequest` has already converted the replayed wire guidance into one developer message in `parsed.context.messages`; adding another parsed-only copy would still duplicate model context. If raw input is a string/non-array, preserve current behavior: parsed context receives the message and raw input is untouched. A matching item in the new suffix does not suppress injection because only replayed proxy state is trusted for idempotence.

## Regression test plan

All new tests go in **MODIFY** `tests/responses-state.test.ts`, whose existing `beforeEach`/`afterEach` isolate `OPENCODEX_HOME`, clear memory, and remove snapshots. Extend imports with `injectDeveloperMessage` from `../src/server/responses` and `consumeForInspection`, `consumeForResponseLogMetadata`, plus the request-log context type or a minimal cast from `../src/server`/the existing export surface. Add a local SSE stream builder and use an `onDone` promise rather than timing sleeps.

Suggested shared fixture:

```ts
function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}
```

Use a structurally valid minimal `RequestLogContext` fixture already accepted by relay tests, or import its type and cast a local `{}` only if the inspector functions tolerate it for the selected events. Prefer the real existing helper if one is present at implementation time.

### Test 1 — inspection consumer backfills and persists done items

Name:

```ts
test("inspection consumer backfills empty completed output before passthrough persistence (#334)", async () => { ... });
```

Fixture/event order:

1. `response.output_item.done`, `output_index: 2`, completed `function_call` item.
2. `response.output_item.done`, `output_index: 0`, completed `reasoning` item.
3. `response.output_item.done`, `output_index: 1`, completed assistant `message` item.
4. `response.completed`, response `{id:"resp_334_inspection", status:"completed", output:[]}`.

Wire `consumeForInspection(..., onCompletedResponse)` so the callback calls `rememberResponseState(requestBody, response, undefined, {force:true})`. Await `onDone`, expand a next request with `previous_response_id: "resp_334_inspection"`, and assert the replayed output types are exactly `reasoning`, `message`, `function_call` after the original input and before the new suffix.

**C-ACTIVATION-GROUNDING-01:** out-of-order indices activate the sort path; all three valid done events activate `Map.set`; the terminal empty array activates backfill; `rememberResponseState` plus the next expansion proves the callback received the reconstructed array and that saved state contains assistant/reasoning/tool-call items. Reading the untouched tee is not part of this unit, so byte preservation is established structurally by the production diff (inspection-only branch) and by the full passthrough suite.

### Test 2 — metadata consumer uses the same backfill path

Name:

```ts
test("metadata consumer backfills missing completed output before passthrough persistence (#334)", async () => { ... });
```

Use at least a `message` done item at index 0 and a `function_call` done item at index 1, followed by `response.completed` whose response has an id/status but **omits** `output`. Wire `consumeForResponseLogMetadata` to the same persistence callback, await `onDone`, expand by that response id, and assert both items are present in index order.

**C-ACTIVATION-GROUNDING-01:** omitted `output` activates the `!Array.isArray(response.output)` side of backfill, while invoking the metadata consumer proves its independent payload loop is wired to the shared accumulator. Successful local replay is the observable persistence proof.

### Test 3 — non-empty terminal output remains authoritative

Name:

```ts
test("non-empty completed output remains authoritative over accumulated done items (#334)", async () => { ... });
```

Send a done event containing a sentinel `function_call`, then complete with a non-empty `output` containing a different sentinel assistant message. Capture the callback response and persist it. Assert the callback's `output` is the exact terminal array/reference and the next replay contains the terminal assistant item but not the accumulated sentinel call.

**C-ACTIVATION-GROUNDING-01:** the prior done event makes the map non-empty, so the only reason the call is excluded is activation of the `Array.isArray(output) && output.length > 0` authoritative path. Reference equality (when captured before stream construction) plus replay content proves the terminal array was not replaced or merged.

### Test 4 — two chained continuations keep one guidance copy

Name:

```ts
test("two previous_response_id continuations keep one replayed guidance item (#326)", () => { ... });
```

Use one stable guidance string and perform this sequence:

1. Parse request 1 with array input, inject guidance once, and persist response 1. Response 1's `output` must include a completed `function_call` item, modeling the post-#334 persisted shape.
2. Expand request 2 from response 1 with a `function_call_output` suffix, parse it, and assert `_replayPrefixLen` covers the saved request-1 input plus output. The replay prefix order must place the guidance before the backfilled function call, so guidance is not at the prefix edge. Call `injectDeveloperMessage` with the same text and assert raw outbound input and parsed context each contain exactly one copy. Persist response 2.
3. Expand request 3 from response 2 with a new user suffix, parse it, call injection again, and assert raw outbound input and parsed context still contain exactly one copy. Persist response 3, expand an audit-only request from response 3, and assert saved state also contains exactly one exact generated wire item.

Count only exact wire items matching the generated shape, and separately count parsed developer messages whose content equals the guidance. Retain the existing `injectDeveloperMessage` test `inserts BEFORE compaction_trigger so it stays the final input item` unchanged.

**C-ACTIVATION-GROUNDING-01:** request 1 activates fresh insertion; request 2's interior replayed guidance activates whole-prefix search and early return; the replayed `function_call` grounds fixture ordering after #334; request 3 activates idempotence on a second chained continuation; raw `_rawBody.input` is the passthrough outbound body observable; audit expansion from response 3 is the saved-state observable. Exact counts of one prove neither dual-write destination accumulated duplicates.

### Test 5 — duplicate output indices are last-write-wins

Name:

```ts
test("duplicate output_index keeps only the final done item (#334)", async () => { ... });
```

Send two valid `response.output_item.done` events at `output_index: 2`: first a sentinel
assistant message, then the final completed `function_call`. Follow them with an empty
`response.completed.response.output`, persist through the inspection consumer, and replay the
saved response. Assert index 2 appears exactly once, contains the final function call, and does not
contain the earlier sentinel. This fixture mandatorily activates the existing `Map.set` replacement
branch rather than merely exercising insertion.

### Test 6 — malformed done events are rejected

Name:

```ts
test("malformed output_item.done events do not enter reconstructed output (#334)", async () => { ... });
```

Interleave one valid index-0 message with done events whose `output_index` is missing, negative,
fractional, and a string, plus one valid-index event whose `item` is missing. Complete with
`output: []`. Assert the callback fires once and reconstructed/persisted output contains only the
valid index-0 item. This is the mandatory activation for every index/item rejection guard.

### Test 7 — exact guidance in the current suffix does not suppress injection

Name:

```ts
test("matching guidance in the current suffix does not suppress replay-prefix injection (#326)", () => { ... });
```

Build an expanded request whose replay prefix contains no exact generated guidance, but whose new
caller suffix contains an item with the exact generated wire shape/text. Set `_replayPrefixLen` to
end immediately before that suffix item, call `injectDeveloperMessage`, and assert a new generated
item is inserted in addition to the suffix item and parsed context receives the injected message.
The observable count is two raw exact-shape items, proving the scan is restricted to trusted replay
provenance rather than all current input.

### Test 8 — malformed SSE payload is skipped without losing completion

Name:

```ts
test("malformed SSE payload is skipped before a valid completed response (#334)", async () => { ... });
```

Use a raw SSE fixture (not the JSON-only helper) containing `data: {not-json}\n\n`, then a valid
index-0 done event and a valid empty-output completion. Run it through each persistence-capable
consumer (table-driven subcases are allowed). Assert no throw, one completion callback per
consumer, and replay contains the valid item. This mandatorily activates the accumulator's JSON
parse catch while proving later frames are still processed.

### Conditional-path activation matrix

| New/changed conditional | Activation scenario | Observable proof |
|---|---|---|
| Null or `[DONE]` payload is ignored | Append `[DONE]` to Test 1 and retain existing null/no-payload coverage | Callback fires once and no throw/regression occurs |
| Malformed SSE payload is ignored | Mandatory Test 8 places raw invalid JSON before valid done/completed frames in both consumers | No throw; one callback; later valid item persists |
| Valid `response.output_item.done` index/item | Tests 1–3 send valid done events | Saved/captured output contains the item |
| Duplicate `output_index` uses Map last-write-wins | Mandatory Test 5 sends two valid items at index 2 | Replay contains exactly one final index-2 item and no sentinel |
| Invalid/missing index or missing item is ignored | Mandatory Test 6 covers missing, negative, fractional, string index and missing item | Callback/replay contains only the one valid item |
| Missing terminal output backfills | Test 2 omits `output` | Saved replay has message + function call |
| Empty terminal output backfills | Test 1 uses `output: []` | Saved replay has reasoning + message + function call |
| Non-empty terminal output is untouched | Test 3 supplies a non-empty terminal array while map is populated | Reference equality and no sentinel call in replay |
| Completion callback absent | Existing cancel/incomplete tests call `consumeForInspection` without it | Existing terminal/cancel assertions remain green; no behavior change |
| Replay prefix length is zero | Existing fresh injection tests plus request 1 in Test 4 | One parsed and one raw guidance insertion |
| Exact guidance exists anywhere in replay prefix | Test 4 places it before a backfilled function call | Injection returns early; counts remain one |
| Similar/non-exact developer item does not suppress | Add a required table-driven subcase to Test 7 with different text and an extra content part in the prefix | Requested exact guidance is still inserted once |
| Matching item exists only in current suffix | Mandatory Test 7 places exact shape/text after `_replayPrefixLen` | Prefix-only scan inserts one new item; raw exact-shape count becomes two |
| Raw input is non-array | Existing `string raw input is left alone` test | Parsed message added; raw string unchanged |
| Fresh raw input ends in `compaction_trigger` | Existing `inserts BEFORE compaction_trigger so it stays the final input item` test | Trigger remains final |

Tests 1–8 and every matrix row marked mandatory/required are acceptance requirements. Table-driven
subcases may share setup, but none may be omitted, folded into an unnamed “existing coverage” claim,
or have its observable weakened.

## Scope boundary

### IN

- Native Responses SSE background inspection used by passthrough response-state recording.
- Reconstruction from finalized output items only.
- Replay-prefix provenance propagation from parser to collaboration injection.
- Exact, prefix-scoped idempotence for proxy-generated developer guidance.
- Focused state-machine regressions and repository-wide verification.

### OUT

- Client-facing SSE mutation, buffering, reordering, or synthesis.
- Delta-to-item reconstruction (`response.output_text.delta`, reasoning deltas, function argument deltas).
- Changes to `rememberResponseState`, `expandPreviousResponseInput`, WeakMap ownership, snapshot schema/version, TTL, byte caps, or eviction.
- Persist-time removal of guidance.
- Changes to `trackSseForRequestLog` beyond a clarifying comment if absolutely necessary; no code-path change is authorized.
- Compaction trigger placement or compaction persistence policy changes.
- Routed-provider bridge output, JSON passthrough, provider adapters, request routing, auth, credentials, workflows, dependencies, release scripts, GUI, or docs-site.

Any need to touch an OUT path or any file not listed in the exact change map is a scope expansion and must be reported to the main agent before editing.

## Docs-site sync decision

No docs-site update. Both issues repair internal continuation correctness and preserve the public wire contract. There is no new option, endpoint, model behavior, or user-facing workflow to document. The regression tests and this devlog artifact are the appropriate durable record.

## Security and privacy

- No authentication, credential, OAuth, workflow, dependency, release, or permission boundary changes are in scope.
- Never log request bodies, replayed input, guidance text, completed output items, tool arguments, account identifiers, or response-state contents.
- The new replay prefix field remains in the in-process parsed object only; it must not be copied into `_rawBody`, serialized upstream, or persisted as a new snapshot field.
- The accumulator is per-consumer/per-stream local state and is released when the consumer finishes. It does not create cross-request global state.
- `bun run privacy:scan` is mandatory even though no new logging is planned.

## Implementation and verification sequence

1. Confirm the worktree is at the intended `origin/dev` baseline and preserve unrelated dirty work.
2. Implement `src/server/relay.ts` helper and consumer wiring without touching the client relay branch.
3. Add `_replayPrefixLen` in `src/types.ts` and populate it in `src/responses/parser.ts`.
4. Implement exact replay-prefix detection in `src/server/responses/collaboration.ts`, retaining fresh compaction-trigger ordering.
5. Add ALL EIGHT named regressions (the four core regressions plus the four
   mandatory matrix tests: duplicate-index last-write-wins, malformed done-event
   rejection, suffix-guidance non-dedupe, malformed-SSE skip) and their
   activation assertions to `tests/responses-state.test.ts`.
6. Run focused tests: `bun test tests/responses-state.test.ts tests/multi-agent-compat.test.ts tests/consume-for-inspection-cancel.test.ts tests/passthrough-abort.test.ts`.
7. Run `bun run typecheck` and require exit 0.
8. Run `bun run test` and require exit 0.
9. Run `bun run privacy:scan` and require exit 0.
10. Inspect `git diff --check`, `git diff --stat`, and the exact changed-path list. Fail if any path outside the implementation map changed.

## Acceptance checklist

- [ ] One shared `Map<output_index, item>` accumulator is used by both persistence-capable SSE consumers.
- [ ] Empty and missing terminal output are backfilled in ascending index order before `onCompletedResponse`.
- [ ] Non-empty terminal output is passed through unchanged and is never merged with accumulated items.
- [ ] `trackSseForRequestLog` remains terminal-status-only and receives no backfill logic.
- [ ] Client-facing native SSE bytes and relay selection remain unchanged.
- [ ] `OcxParsedRequest` receives proxy-private replay prefix length without changing the wire body.
- [ ] Guidance detection searches the whole replay prefix for the exact generated item shape.
- [ ] A replay hit skips both parsed-context and raw-input insertion.
- [ ] Fresh guidance insertion still precedes a final `compaction_trigger`.
- [ ] #326 fixtures include the post-#334 persisted `function_call` shape.
- [ ] Two chained continuations produce one guidance copy in outbound input and one in persisted/replayed state.
- [ ] Focused tests, typecheck, full test suite, and privacy scan all exit 0.
- [ ] No request-body or response-item logging was introduced.

## Issue-comment traceability self-check

- [ ] **#334 reporter — `relay.ts` empty-output backfill:** implemented by the file-private accumulator, `output_index` Map ordering, and both consumer wiring sections above.
- [ ] **#334 reporter — regression test:** covered by the inspection empty-output persistence test, metadata missing-output persistence test, and non-empty authoritative-output test.
- [ ] **#326 reporter kdnsna — idempotent injection or persist exclusion:** implemented using the accepted idempotent injection option; replay provenance is copied to `OcxParsedRequest`, the exact guidance item is searched across the prefix, and the rejected five-call-site persist exclusion is explicitly out of scope.
- [ ] **#326 reporter kdnsna — two-continuation regression:** covered by the request-1 → response-1 → request-2 → response-2 → request-3 sequence, with raw outbound and audit-replayed saved-state counts fixed at one.
- [ ] **Cross-issue ordering:** the #326 fixture deliberately replays a #334-style completed `function_call`, proving guidance detection does not assume a prefix-edge position.
- [ ] **Compaction invariant:** the existing regression requiring generated guidance before final `compaction_trigger` remains mandatory and unchanged.
