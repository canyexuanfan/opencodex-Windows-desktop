# 030 — Phase 3: `xai/grok-4.6` does not use `apply_patch`

Added mid-loop at the user's request (LOOP-UNIT-CHAIN-01).
**Revised after an adversarial audit returned FAIL** (findings 9, 10).

## What is proven

Codex advertises `apply_patch` as a **freeform/custom** tool (`type: "custom"`
with a grammar). On the xai path that form is lowered twice:

1. `src/responses/parser.ts:184` replaces the grammar with `{input: string}`.
2. `src/adapters/openai-chat.ts:1183` serializes every internal tool — including
   `freeform: true` ones — as `type: "function"` (`:1194`).

xai resolves to `openai-chat` (`registry.ts:985`) and always posts to
`/chat/completions` (`openai-chat-url.ts:7`); OAuth only swaps URL/headers
(`xai-transport.ts:101`, `:142`). The tool is **not** dropped — `{input: string}`
is a concrete schema and passes the filter (`openai-chat.ts:1141`, `:1193`).

The **return path is already correct**: the tool stays `freeform: true`
(`parser.ts:196`), the bridge recognizes it (`bridge.ts:1023`), unwraps `{input}`
(`:220`), and emits a `custom_tool_call` (`:621`). Nothing downstream is broken.

## What is NOT proven (audit correction)

The original root cause said Grok is "never told" what `apply_patch` is. **False.**
`parser.ts:189` already attaches apply_patch-specific guidance to the `input`
property — "begin exactly with `*** Begin Patch` … then use its standard patch
envelope" — and `tests/responses-custom-tool-guidance.test.ts:15` covers it.

So source reading proves a **lossy conversion**, not that the loss is why Grok
declines the tool. The honest statement of this phase:

> The freeform contract is provably erased on the xai path. Whether that erasure
> is what makes grok-4.6 avoid `apply_patch` is **not established by reading the
> source**, because per-property guidance already exists.

Competing explanations that this decode cannot rule out: Grok weighting an
alternative edit affordance, the model disliking a large opaque string parameter,
or prompt-level factors unrelated to the tool catalog.

## Decision: treat as an experiment, not a fix

Any change here is a hypothesis test that needs a **live xai call** to evaluate.
This loop's evidence rules forbid claiming success from a green fixture suite, so
this phase does not get to declare victory from unit tests.

Options, re-ranked after the audit:

1. **Structured edit aliases** (mirroring Cursor's `edit_file`/`multi_edit`,
   `cursor/tool-definitions.ts:274`, translated at `protobuf-events.ts:1170`).
   Matches xAI's documented JSON-schema function contract and removes the need
   for Grok to author patch grammar. Largest surface: two synthetic tools, a
   translation path, and provenance gating so a legitimate MCP `edit_file` is
   never hijacked (#1036).
2. **Sharpened system guidance.** Small and reversible, but per-property guidance
   already exists, so this is the *weaker* hypothesis — not the obvious first
   move the original doc claimed.
3. **Native Responses routing.** Cleanest contract, but xAI documents client tools
   as JSON-schema functions requiring an object `parameters`, and describes Chat
   Completions as function-calling only
   (<https://docs.x.ai/developers/tools/function-calling>). Needs a live
   capability probe and risks OAuth transport and continuation regressions.

**Chosen: (2) first, gated as described below, then measure.** It is the cheapest
probe of the affordance hypothesis. If a live run still shows Grok avoiding
`apply_patch`, escalate to (1) rather than iterating on wording.

## Mandatory scoping (audit correction)

The original plan would have fired for **every** `openai-chat` provider carrying a
freeform `apply_patch`, and "prefer it for every file edit" could override a
legitimate sibling edit tool.

- Gate on the resolved provider being xai, not merely on the adapter being
  `openai-chat`. No other provider's prompt changes.
- Suppress the note when the catalog already contains another edit-capable tool,
  so guidance never demotes a tool the user deliberately supplied.
- Keep it additive to the existing catalog nudge (`openai-chat.ts:621`,
  `tool-catalog-nudge.ts:59`) and byte-cheap; it rides every request.

## Tests (`tests/xai-apply-patch-guidance.test.ts`)

1. xai + freeform `apply_patch` -> the note appears exactly once.
2. A non-xai `openai-chat` provider with the same catalog -> **no note**
   (provider isolation; guards audit finding 10).
3. xai + a catalog containing a sibling edit tool -> **no note**.
4. xai without `apply_patch` -> no note.
5. The advertised tool remains `type: "function"` with `{input: string}` —
   guidance must not alter the wire schema.
6. A returned `apply_patch` call still decodes to a `custom_tool_call`
   (regression over `bridge.ts:621`).

## Done when

All six pass, typecheck clean, suite green on `ssh lidge`, pushed — and the
report states plainly that the behavioral claim is **unverified pending a live
xai run**. Passing tests prove delivery and isolation, never that Grok changed
its mind.

