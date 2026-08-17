# 030 — Phase 3: `xai/grok-4.6` does not use `apply_patch`

Added mid-loop at the user's request (LOOP-UNIT-CHAIN-01).
**Revised twice after adversarial audits** (round 1 findings 9-10, round 2
findings 1, 3, 5, 6).

## What is proven

Codex advertises `apply_patch` as a **freeform/custom** tool (`type: "custom"`
with a grammar). On the xai path that form is lowered twice:

1. `src/responses/parser.ts:184` replaces the grammar with `{input: string}`.
2. `src/adapters/openai-chat.ts:1183` serializes every internal tool — including
   `freeform: true` ones — as `type: "function"` (`:1194`).

xai resolves to `openai-chat` (`registry.ts:985`) and posts to
`/chat/completions` (`openai-chat-url.ts:7`); OAuth only swaps URL/headers
(`xai-transport.ts:101`, `:142`). The tool is **not** dropped —
`{input: string}` is a concrete schema and passes the filter (`:1141`, `:1193`).

The **return path is already correct**: the tool stays `freeform: true`
(`parser.ts:196`), the bridge recognizes it (`bridge.ts:1023`), unwraps `{input}`
(`:220`), and emits a `custom_tool_call` (`:621`).

**Proven claim: a lossy conversion. Nothing more.**

## What is NOT proven (round 1, finding 9)

`parser.ts:189` already attaches apply_patch-specific guidance to the `input`
property — "begin exactly with `*** Begin Patch` … then use its standard patch
envelope" — covered by `tests/responses-custom-tool-guidance.test.ts:15`.

So the claim that Grok is "never told" what `apply_patch` is was **false**, and
whether the grammar erasure is why Grok declines the tool is **not established by
reading source**. Competing explanations this decode cannot rule out: Grok
weighting an alternative edit affordance, dislike of a large opaque string
parameter, or prompt-level factors unrelated to the catalog.

## The scoping seam does not exist yet (round 2, finding 1)

The previous revision required gating on "the resolved provider being xai". That
is **not implementable where the plan put it**: `createOpenAIChatAdapter()`
receives only `OcxProviderConfig`, the adapter factory context carries no
provider name (`adapters/registry.ts:15-17,57-60`), and `resolveAdapter()` drops
`route.providerName` (`server/adapter-resolve.ts:51-52`,
`server/responses/core.ts:2142`). Host-based detection would misclassify custom
providers, and a provider-isolation test could pass merely by using a different
base URL — a test that proves nothing.

**Consequence: this phase now includes threading provider identity through
adapter construction**, as an explicit, reviewable scope expansion rather than a
hidden assumption. If that seam turns out to be more invasive than the experiment
justifies, the honest move is to defer the phase, not to fake the gate with a
host regex.

## The sibling-tool predicate is under-specified (round 2, finding 3)

"Suppress when another edit-capable tool exists" has no definition. `OcxTool`
carries no edit-capability provenance (`types.ts:206-224`), name matching misses
arbitrary MCP edit tools, and description matching would suppress the experiment
whenever ordinary code-mode `exec` is present (`tool-catalog-nudge.ts:12-17`).

**Resolution: drop the sibling-tool gate.** Replace it with a narrower, decidable
rule — the note is phrased to describe how to *call* `apply_patch` when it is
used, not to command that it be preferred over every other tool. Guidance that
does not claim exclusivity cannot demote a sibling tool, which removes the need
for a predicate nobody can define.

## xAI capability, corrected (round 2, finding 5)

The earlier statement that xAI describes Chat Completions as "function-calling
only" was too strong. Current xAI documentation demonstrates custom function
calling through `/v1/responses`, while still requiring object-root JSON-schema
function tools — so native Responses would **not** preserve Codex's freeform
grammar automatically; lowering remains necessary either way.
<https://docs.x.ai/developers/tools/function-calling>

Any option-3 evaluation must also distinguish public API-key Responses support
from the OAuth CLI proxy (`xai-transport.ts:101`), which are different surfaces.

## Decision

Options, ranked after two audits:

1. **Structured edit aliases** (mirroring Cursor's `edit_file`/`multi_edit`,
   `cursor/tool-definitions.ts:274`, translated at `protobuf-events.ts:1170`).
   Matches xAI's documented JSON-schema contract; largest surface, needs
   provenance gating so a legitimate MCP `edit_file` is never hijacked (#1036).
2. **Sharpened call-shape guidance**, xai-scoped via the new identity seam.
   Cheapest probe, but per-property guidance already exists, so it is the weaker
   hypothesis.
3. **Native Responses routing.** Needs a live capability probe on both xai
   surfaces; risks OAuth transport and continuation regressions.

**Chosen: (2), explicitly as an experiment**, with the identity seam as declared
scope. If a live run still shows Grok avoiding `apply_patch`, escalate to (1)
rather than iterating on wording.

## Tests (`tests/xai-apply-patch-guidance.test.ts`)

1. xai + freeform `apply_patch` -> the note appears exactly once.
2. A non-xai `openai-chat` provider **with the same base URL** -> no note.
   Same-URL is mandatory: it is what proves identity gating rather than host
   sniffing (round 2 finding 1).
3. xai without `apply_patch` -> no note.
4. The advertised tool remains `type: "function"` with `{input: string}` —
   guidance must not alter the wire schema.
5. A returned `apply_patch` call still decodes to a `custom_tool_call`
   (regression over `bridge.ts:621`).
6. The provider-identity seam itself: a route's provider name reaches the adapter.

## Done when

All six pass, typecheck clean, suite green on `ssh lidge`, pushed — and the
report states plainly that the behavioral claim is **unverified pending a live
xai run**. Passing tests prove delivery and isolation, never that Grok changed
its mind.

