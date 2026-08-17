# 030 — Phase 3: `xai/grok-4.6` does not use `apply_patch`

Added mid-loop at the user's request (LOOP-UNIT-CHAIN-01). Verified by an
independent `gpt-5.6-sol` investigation. This is a **different provider** from
the rest of the unit — `xai`, not `cursor` — but the same underlying subject:
what a model is actually told it can call.

## Root cause

Codex advertises `apply_patch` as a **freeform/custom** tool: `type: "custom"`
with a grammar, not a JSON-schema function. On the xai path that contract is
erased twice:

1. `src/responses/parser.ts:184` discards the custom tool's `format`/grammar and
   substitutes `{input: string}` (`:189`).
2. `src/adapters/openai-chat.ts:1183` serializes every internal tool — including
   `freeform: true` ones — as `type: "function"` (`:1194`).

xai resolves to the `openai-chat` adapter (`registry.ts:985`,
`adapters/registry.ts:57`) and always posts to `/chat/completions`
(`openai-chat-url.ts:7`); OAuth only swaps URL/headers
(`xai-transport.ts:101`, `:142`). So Grok sees an ordinary function and is
implicitly asked to (a) pick it, (b) author the entire Codex patch language
inside one JSON string, and (c) get `*** Begin Patch` exactly right — with no
guidance saying so.

The tool is **not** dropped by schema normalization: `{input: string}` is a
concrete object and passes the filter (`openai-chat.ts:1141`, `:1193`).

## The return path is already correct

If Grok does call it, decoding works: the tool stays tagged `freeform: true`
(`parser.ts:196`), `buildToolBridgeMaps` records it
(`collaboration.ts:130`), the bridge recognizes the name (`bridge.ts:1023`),
unwraps `{input}` (`:220`), and emits a Responses `custom_tool_call` (`:621`).

**So this is an affordance defect, not a codec defect.** Nothing downstream needs
fixing, which is why the existing conformance test passes while the real behavior
fails: `tests/adapter-tool-conformance.test.ts:358` fabricates a valid upstream
call and checks decoding. It proves round-trip, never that Grok chooses the tool.

## Why Cursor does not have this problem

Cursor detects a request-declared freeform `apply_patch`
(`cursor/tool-definitions.ts:241`), synthesizes model-native `edit_file` /
`multi_edit` tools (`:274`), advertises them as client-tool definitions
(`:667`), and injects system guidance preferring them (`:637`). Calls come back
as structured edits and are translated into a valid patch
(`protobuf-events.ts:1170`). The xai path has only a generic catalog nudge that
lists names without recommending anything (`openai-chat.ts:621`,
`tool-catalog-nudge.ts:59`).

## xAI capability (checked, not assumed)

As of 2026-08-17 xAI documents client tools as JSON-schema function calls and
requires a JSON object for `parameters`; it does not document OpenAI's
`type: "custom"` grammar form, and describes Chat Completions as function-calling
only. <https://docs.x.ai/developers/tools/function-calling>,
<https://docs.x.ai/developers/model-capabilities/text/comparison>

There is no `supportsCustomTools` capability flag in the registry
(`registry.ts:244`). `src/responses/custom-tool-compat.ts:59` converts custom to
function generically but explicitly exempts `apply_patch` (`:1`), and it belongs
to the `openai-responses` path, not this one.

## Decision

**Option 2 first (guidance), then reassess.** Rejected alternatives:

- *Structured edit aliases for xai* (mirroring Cursor) is the most likely to work
  but is a large new surface: two synthetic tools, a translation path, and
  provenance gating so a legitimate MCP `edit_file` is never hijacked. That gate
  exists in Cursor for a reason (#1036). It is the fallback if guidance measurably
  fails, not the opening move.
- *Route xai through native Responses* is cleanest in principle but xAI does not
  document support for grammar tools, and it risks OAuth transport, reasoning
  replay, and continuation regressions. Requires a live capability probe first.

Guidance is small, reversible, and directly addresses the proven gap: Grok is
never told that `apply_patch` is the edit tool or what its payload looks like.

## Diff-level plan

**`src/adapters/openai-chat.ts`** (or a small helper beside
`tool-catalog-nudge.ts`)

- When the translated catalog contains a tool that was `freeform: true` and named
  `apply_patch`, append a short, explicit system note: prefer `apply_patch` for
  every file edit; pass the whole patch as the `input` string; the payload must
  begin `*** Begin Patch` and end `*** End Patch`; include one `*** Update File:`
  / `*** Add File:` header per file; do not wrap it in markdown fences.
- Gate strictly on provenance — the request declared a freeform `apply_patch` —
  so a provider without that tool gets no note. Keep it additive to the existing
  nudge rather than replacing it.
- Keep it byte-cheap; this rides on every request.

## Tests (`tests/xai-apply-patch-guidance.test.ts`)

1. A request declaring freeform `apply_patch` produces the guidance note in the
   outgoing system content, exactly once.
2. A request without `apply_patch` produces no note (no leakage to other setups).
3. The note does not displace or duplicate the existing catalog nudge.
4. The advertised tool is still a valid `type: "function"` with `{input: string}`
   — guidance must not alter the wire schema.
5. A returned `apply_patch` function call still decodes to a Responses
   `custom_tool_call` (regression over `bridge.ts:621`).

## Honest limit

Guidance changes the odds, not the contract. Verifying that Grok 4.6 actually
uses `apply_patch` needs a live xai call, which this loop's evidence rules do not
let me fake with a fixture. The tests above prove the note is delivered correctly;
the behavioral claim stays open until a live run, and `030` will say so rather
than declaring victory from a green suite.

