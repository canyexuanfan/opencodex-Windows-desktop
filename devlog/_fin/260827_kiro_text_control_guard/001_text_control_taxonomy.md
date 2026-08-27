# 001 — How each adapter treats Responses \`text\` controls

Research only. No diffs here (LEXICO-SPLIT-01); the implementation design is
\`010\`.

## The two things \`text\` carries

The Responses \`text\` object mixes two unrelated concerns, which is the root of
the confusion this unit fixes:

- \`text.format\` — **output shape**. \`json_schema\` and \`json_object\` constrain
  the model to emit parseable JSON. \`type: "text"\` is the default: ordinary
  prose. A provider that cannot constrain output genuinely cannot honour the
  first two, and has nothing to honour for the third.
- \`text.verbosity\` — **output length preference**. A hint. A provider that
  ignores it produces a slightly longer or shorter answer, and nothing breaks.

Conflating them means treating a length hint as an unsatisfiable contract.

## What the parser already decides

\`src/responses/parser.ts\`:

- \`parseTextFormat\` (\`:829-843\`) returns a value **only** for \`json_schema\` and
  \`json_object\`. Its own docstring: *"unknown or malformed formats are ignored,
  never rejected, so the native passthrough keeps forwarding whatever the caller
  sent via \`_rawBody\`."*
- \`options.textFormat\` is set from that result (\`:801\`).
- \`_structuredOutput: true\` is derived from the same result (\`:817\`).

So the proxy's own parser already draws the line this unit needs. The Kiro guard
simply does not consult it, reaching past \`_structuredOutput\` to test
\`_rawBody.text\` for mere existence.

## Per-adapter comparison

| Adapter | \`json_schema\` / \`json_object\` | \`verbosity\` | \`format:"text"\` |
|---|---|---|---|
| \`openai-responses\` (passthrough) | forwarded verbatim from \`_rawBody\` | **stripped** when the model advertises \`supportsVerbosity: false\` (\`:379-398\`) | forwarded |
| \`openai-chat\` | re-nested as chat \`response_format\` (\`:~\`) | not applicable to the chat wire | not applicable |
| \`anthropic\` | mapped to an output schema via \`normalizeAnthropicOutputSchema\` | not applicable | not applicable |
| \`kiro\` (today) | **rejected** | **rejected** | **rejected** |
| \`kiro\` (this unit) | rejected | tolerated, not forwarded | tolerated, not forwarded |

Kiro is the only adapter that turns a client hint into a 400. Every other
adapter either maps the control, drops it, or ignores it.

## The precedent that matters most

\`src/adapters/openai-responses.ts:379-398\`, \`stripDisabledVerbosity\`:

    /**
     * Hide a no-op Responses verbosity control from the wire as well as the catalog. This runs at
     * final serialization so a stale catalog or direct caller cannot bypass the capability. Other
     * \`text\` settings (notably structured-output \`format\`) remain untouched.
     */

Three things worth extracting:

1. **The catalog is not the enforcement point.** The comment explicitly
   anticipates "a stale catalog or direct caller". A capability flag is a
   declaration; the wire needs its own handling.
2. **The disposition for an unsupported control is to drop it**, not to refuse
   the turn.
3. **\`format\` is deliberately exempted** from that dropping, because output
   shape is a real contract while verbosity is a preference. Exactly the
   distinction this unit draws inside the Kiro guard.

Kiro needs no equivalent stripper, for a structural reason: it does not
serialize from \`_rawBody\` at all. \`buildKiroPayload\` constructs
\`conversationState\` field by field from \`parsed\`. A \`text\` control the guard
stops rejecting is therefore simply never read — dropped by construction. The
fix is subtraction, and \`010\`'s A6 assertion pins that property.

## Why the catalog does not already prevent this

It does its job; the job is just narrower than it looks. On the operator's
machine \`kiro/claude-opus-5\` carries \`support_verbosity: false\`. But:

- \`ensureStrictCatalogFields\` (\`src/codex/catalog/parsing.ts:408\`) defaults
  \`support_verbosity\` to \`true\` when a source asserts nothing, so a row without
  explicit provider evidence advertises the control.
- Clients cache catalogs. A Codex instance holding an older \`models_cache.json\`
  keeps sending \`verbosity\` after the catalog says stop.
- \`text.format.type: "text"\` is **not governed by any capability flag at all**.
  No catalog value suppresses it, because it is the default output mode. A
  client sending it is behaving correctly. That case alone means catalog
  correctness can never fully prevent this 400.

## The sibling defect already fixed

\`db040e70f\`, \`structure/04_transports-and-sidecars.md\` — *Kiro client
parallel-tool hint*:

> That request field is permissive: it allows parallel calls but does not
> require the routed transport to expose a matching flag.

and, from the same decision log:

> Rejection interprets permission as a requirement and blocks valid turns.

Substitute "verbosity preference" for "parallel calls" and the paragraph needs
no other edit. The same function contained both defects; one was removed on
2026-08-21, the other was not noticed because \`_structuredOutput\` was in the
condition and looked like it was doing the discriminating.

## Open questions (settled)

- *Should Kiro map \`verbosity\` onto its emulated thinking budget?* No. Out of
  scope, and it would invent a behavior the upstream never promised. Tolerate
  and ignore.
- *Should the guard reject unknown \`text\` members defensively?* No. That is the
  current defect restated. The parser's stance — ignore what you do not
  understand — is the house convention.
- *Does the routed-compaction path still need to delete \`_rawBody.text\`?*
  (\`src/server/responses/core.ts:3099\`) Not for correctness after this change,
  but its comment names two consumers and the key-mode \`openai-responses\`
  adapter is the other. Leave it.

