# 000 — Kiro Responses \`text\` capability guard is over-broad

**Unit:** \`devlog/_plan/260827_kiro_text_control_guard/\`
**Class:** C3 (shared adapter surface, public request contract, cross-session persistence)
**Opened:** 2026-08-27
**Status:** planning

## Objective

Stop \`kiro/*\` routed turns from failing with HTTP 400
\`invalid_request_error\` when the Codex client sends a Responses \`text\` object
that is not structured output. Reject only genuine structured output
(\`text.format\` of type \`json_schema\` or \`json_object\`), which Kiro really
cannot honour.

## Symptom (live, not reconstructed)

Reported from Kiro-routed Codex usage; confirmed on the operator's Mac mini
(\`macmini-cf\`, opencodex \`2.33.0\`, proxy pid 56468 on 127.0.0.1:10100).

Client-visible error:

    Error: error in request: {"error":{"message":"Kiro does not support Responses
    text controls or structured output","type":"invalid_request_error",
    "code":"invalid_request_error"}}

\`~/.opencodex/usage.jsonl\` holds 10 matching rows, most recently
2026-08-27T12:11:27. Representative row (elided):

    {"requestId":"ocx-mtaxtnmo-kl","provider":"kiro","model":"claude-opus-5",
     "admissionKind":"loopback","inboundProtocol":"responses",
     "requestedModel":"kiro/claude-opus-5","status":400,"durationMs":7,
     "attempts":[{"ordinal":1,"adapter":"kiro","status":400,"sendCount":0,
       "errorCode":"invalid_request_error"}],
     "closeReason":"non_stream",
     "upstreamError":"Kiro does not support Responses text controls or structured output",
     "routeDecision":{"routeKind":"explicit-provider","selected":{"provider":"kiro",
       "model":"claude-opus-5","reason":"explicit-provider-namespace"}}}

\`sendCount: 0\` locates the failure precisely: the request never reached Kiro.
It was refused inside our adapter while building the payload.

**The failure is intermittent, and that is the diagnostic tell.** The same model
succeeds on the surrounding turns:

    12:11:05.864  kiro/claude-opus-5  200
    12:11:15.759  kiro/claude-opus-5  200
    12:11:27.153  kiro/claude-opus-5  400   <- guard
    12:11:27.164  kiro/claude-opus-5  400   <- guard
    12:11:27.170  kiro/claude-opus-5  400   <- guard
    12:11:09.376  kiro/claude-opus-5  200

Authentication is healthy. Routing is healthy (\`explicit-provider-namespace\`
selects the intended candidate with no exclusions). Only certain request
*shapes* fail.

## Cause

\`src/adapters/kiro.ts:316-328\`, \`validateKiroCapabilities\`:

    const raw = parsed._rawBody as Record<string, unknown> | undefined;
    if (parsed._structuredOutput || raw?.text !== undefined) {
      throw new Error("Kiro does not support Responses text controls or structured output");
    }

The second disjunct tests the **presence of the \`text\` key**, not its content.
Any \`text\` member refuses the turn: \`text.verbosity\`, \`text.format.type:"text"\`
(which is plain prose, the opposite of structured output), even \`text: {}\`.

\`buildKiroPayload\` (\`src/adapters/kiro.ts:436\`) calls the validator as its first
statement, so the throw happens before any wire serialization — matching
\`sendCount: 0\`.

### Live reproduction against the running proxy

Posted to \`http://127.0.0.1:10100/v1/responses\` with
\`model: "kiro/claude-opus-5"\` and an identical single-message input, varying
only \`text\`:

| \`text\` member sent | Result |
|---|---|
| *(key absent)* | **200** — normal completion returned |
| \`{"verbosity":"medium"}\` | 400 \`invalid_request_error\` |
| \`{"format":{"type":"text"}}\` | 400 — and this is *not* structured output |
| \`{}\` | 400 |

### Parser-level confirmation

\`parseRequest\` already separates the two concepts cleanly
(\`src/responses/parser.ts:799-817\`, \`parseTextFormat\` at \`:829\`). Observed
directly:

| input \`text\` | \`_structuredOutput\` | \`options.textFormat\` | \`_rawBody.text\` present |
|---|---|---|---|
| \`{verbosity:"medium"}\` | \`false\` | \`null\` | \`true\` |
| \`{format:{type:"text"}}\` | \`false\` | \`null\` | \`true\` |
| \`{}\` | \`false\` | \`null\` | \`true\` |
| \`{format:{type:"json_schema",...}}\` | \`true\` | set | \`true\` |
| \`{format:{type:"json_object"}}\` | \`true\` | set | \`true\` |

\`_rawBody.text !== undefined\` is \`true\` in **all five** rows — it cannot
discriminate. \`_structuredOutput\` is exactly the discriminator the guard needs,
and it is already computed. \`parseTextFormat\` returns a value only for
\`json_schema\` and \`json_object\`; every other format, malformed or unknown, is
ignored rather than rejected.

## Why the \`verbosity\` control reaches the adapter at all

The generated catalog is already correct. On the operator's machine
\`~/.codex/opencodex-catalog.json\` carries:

    {"slug": "kiro/claude-opus-5", "support_verbosity": false, "default_verbosity": "low"}

So the advertised capability is honest. What Kiro lacks is the **serialization-stage**
tolerance every other provider gets. \`src/adapters/openai-responses.ts:379-398\`,
\`stripDisabledVerbosity\`, drops a no-op \`verbosity\` at final serialization, and
its own comment states the reason: *"This runs at final serialization so a stale
catalog or direct caller cannot bypass the capability. Other \`text\` settings
(notably structured-output \`format\`) remain untouched."*

That is precisely the shape of handling Kiro is missing. The catalog is a
declaration; the wire needs a filter. Kiro has neither filter nor tolerance — it
has a refusal.

## Precedent in this repository

\`db040e70f\` — *fix(kiro): accept permissive parallel tool hints* — removed a
sibling over-rejection from the same function five days earlier:

    -  if (parsed.options.parallelToolCalls === true) {
    -    throw new Error("Kiro does not support parallel tool calls");
    -  }

The reasoning recorded in \`structure/04_transports-and-sidecars.md\` transfers
almost verbatim: the client field was **permissive, not a requirement**, so
refusing it "interprets permission as a requirement and blocks valid turns."
\`text.verbosity\` and \`text.format.type:"text"\` are permissive in exactly the
same way. This unit finishes the job that commit started, and reuses its shape:
narrow the guard, keep the wire unchanged, document the decision, test both
directions.

## Scope

**IN**

- \`src/adapters/kiro.ts\` — narrow \`validateKiroCapabilities\`.
- \`tests/kiro-adapter.test.ts\` — regression coverage both ways.
- \`docs-site/src/content/docs/reference/adapters.md\` — user-facing contract.
- \`structure/04_transports-and-sidecars.md\` — decision log.
- This devlog unit.

**OUT**

- Kiro OAuth refresh repetition (54 \`OAuth refresh started provider=kiro\` lines
  in \`service.log\`). Observed, unrelated, its own unit.
- Cursor model-discovery HTTP failure dropping 13 configured model ids.
  Observed, unrelated, its own unit.
- The core/Lab import boundary (\`src/router.ts\`, \`src/server/lifecycle.ts\`,
  \`src/server/responses/core.ts\`). Untouched.
- Credential, OAuth, workflow, and release paths — the \`AGENTS.md\` security
  review surface. Untouched.
- Any change to what Kiro can actually *do*. Structured output stays rejected.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| Phase | Doc | Deliverable | Consumes |
|---|---|---|---|
| wp1 | this unit | Diff-level roadmap, live evidence, verifier baselines | — |
| wp2 | \`010\` | Guard narrowing + regression tests + docs | wp1's audited plan |
| wp3 | \`020\` | PR against \`dev\`, CI green at exact head SHA | wp2's verified tree |

The order is structural, not schedule-driven: wp3 can only prove CI on a tree
wp2 produced, and wp2 can only be audited against a plan wp1 wrote.

## Acceptance criteria

| # | Criterion | How C proves it |
|---|---|---|
| A1 | \`text.verbosity\` reaches Kiro | Unit test + live replay returning 200 |
| A2 | \`text.format.type:"text"\` reaches Kiro | Unit test asserting no throw |
| A3 | \`text: {}\` reaches Kiro | Unit test asserting no throw |
| A4 | \`json_schema\` still rejected | Retained assertion, must still throw |
| A5 | \`json_object\` still rejected | New assertion, must still throw |
| A6 | No \`text\` control is forwarded onto the Kiro wire | Assert the serialized payload has no \`text\`/\`verbosity\` key |
| A7 | Repository gates green | \`bun run typecheck\` + \`bun run test\`, exit 0 |
| A8 | The narrowed branch actually fires | Activation evidence: the new tests fail against the pre-fix guard |

A8 is C-ACTIVATION-GROUNDING-01. A guard change whose tests would pass either
way proves nothing, so the tests are run against the old guard first and must
fail there.

## Verifiers (PLAN-VERIFIER-REAL-01 — run before being written down)

| Command | Exit | Reads this unit's target? |
|---|---|---|
| \`bun install\` | 0 | Prerequisite. The worktree had no \`node_modules\`; \`bun test\` died with \`Cannot find module 'zod/v4' from src/config.ts\` until it ran. |
| \`bun test tests/kiro-adapter.test.ts\` | 0 (56 pass, 272 expects) | **Yes** — direct path argument; the file imports \`createKiroAdapter\` from \`../src/adapters/kiro\`. |
| \`bun x tsc --noEmit\` | to be captured in wp2 | **Partly** — \`tsconfig.json\` says \`"include": ["src"]\`, so it covers \`src/adapters/kiro.ts\` but **not** \`tests/\`. Corrected in \`002\` after audit round 1; the original claim here was wrong. |
| \`cd docs-site && bun run build\` | to be captured in wp2 | **Yes** — \`010\` edits \`docs-site/src/content/docs/reference/adapters.md\`. |
| \`bun run test\` | to be captured in wp2 | **Yes** — full \`tests/\` suite; required by \`AGENTS.md\` before a review-ready PR because this is shared adapter behavior. |
| \`gh pr checks <n>\` | wp3 | **Yes** — reports the pushed head SHA's CI. |

Baseline recorded 2026-08-27 at \`9b838d062\`: \`bun test tests/kiro-adapter.test.ts\`
→ \`56 pass, 0 fail\`, exit 0. Any post-change failure is attributable.

## Bypass analysis (PLAN-BYPASS-NAMED-01)

This unit **removes** an over-broad rejection; it adds no enforcement layer.

- **Tier:** E1 (adapter-local input validation).
- **Executing surface:** \`validateKiroCapabilities\`, called by \`buildKiroPayload\`.
- **Known bypass path:** none for the retained structured-output refusal — every
  Kiro turn is serialized through \`buildKiroPayload\`, whose first statement is
  the validator (\`src/adapters/kiro.ts:436\`). A caller reaching Kiro without it
  would have to construct the wire payload independently; no such path exists in
  \`src/\`. Evidence: \`rg 'buildKiroPayload' src/\` returns the definition and one
  call site.
- **Residual risk:** if Kiro later gains real structured-output support, the
  retained refusal becomes wrong in the opposite direction. Cheap to revisit;
  the discriminator is one flag.
- **Wording downgrade:** none. The claim stays "the adapter refuses structured
  output," which is what the code does.

## Field chain (PLAN-FIELD-CHAIN-01)

No new field or enum value is introduced. The unit changes a boolean condition
over two values that already exist end to end:

| Stage | \`_structuredOutput\` | \`_rawBody.text\` |
|---|---|---|
| Creation | \`src/responses/parser.ts:817\`, set from \`parseTextFormat\` | \`src/responses/parser.ts\`, the verbatim inbound body |
| Serialization | N/A — process-local, never sent upstream | forwarded verbatim by native passthrough only |
| Deserialization | N/A — never persisted or replayed | N/A |
| Consumers | \`src/web-search/loop.ts:745\`, \`src/adapters/kiro.ts:325\`, \`src/server/responses/core.ts:3099\` (deletes it for routed compaction) | \`src/adapters/kiro.ts:325\`, \`src/adapters/openai-responses.ts\` |

The routed-compaction path at \`core.ts:3090-3100\` deletes \`options.textFormat\`,
\`_structuredOutput\`, **and** \`_rawBody.text\` together, with a comment naming
this very guard as the reason. After this unit, that third deletion is belt and
braces rather than load-bearing — worth noting, not worth removing.

## Risks

1. **Silently forwarding a control Kiro ignores.** Mitigated by A6: assert the
   serialized payload carries no \`text\` key. The Kiro payload is built
   field-by-field from \`parsed\`, never spread from \`_rawBody\`, so this is
   structurally true; A6 pins it against regression.
2. **Weakening the structured-output refusal.** Mitigated by A4/A5 asserting
   both structured shapes still throw, and by A8 proving the tests discriminate.
3. **A future \`text\` member that Kiro genuinely cannot ignore.** Accepted. The
   guard is a denylist of one concept now instead of an allowlist of none; if
   such a member appears, it gets its own condition. Recorded here so the next
   reader knows it was a decision, not an oversight.

## Outcome — DONE (2026-08-27)

Shipped as [#2725](https://github.com/lidge-jun/opencodex/pull/2725), open against
`dev`, head `314d41d8a`, all 23 CI checks green at that exact SHA, `MERGEABLE`,
awaiting maintainer review. Merging is not the agent's to do.

### What shipped

| Commit | Change |
|---|---|
| `56be8f671` | This planning unit |
| `524a294f8` | Regression tests, red against the old guard |
| `a0d1ebbe4` | The guard narrowed to `_structuredOutput` |
| `ce52a0016` | docs-site bullet, structure Decision Log, two stale comments |
| `314d41d8a` | Made the third wire-absence assertion non-vacuous |

### Verified

`bun x tsc --noEmit` 0 · `bun run test` 0 (15279 pass / 0 fail) ·
`bun run privacy:scan` 0 · `docs-site` build 0 (401 pages) ·
`tests/kiro-adapter.test.ts` 58 pass / 306 expects.

Activation evidence was captured *before* the fix and committed, so the defect is
reproducible from history rather than asserted.

### What the plan got wrong

Worth recording, because both were caught by review rather than by me:

1. **The verifier claim was false.** `000` asserted `tsconfig.json` covered
   `src/` and `tests/`. It is `"include": ["src"]`. The command had been run and its
   exit code recorded — but the *reads-the-target* half was asserted from the
   config's reputation instead of its contents. PLAN-VERIFIER-REAL-01 asks for the
   `include` entry to be quoted; it was not, and the claim was wrong.
2. **A vacuous assertion nearly shipped.** The wire-absence check asserted
   `context?.text` on a fixture that advertised no tool, so the adapter never built
   `userInputMessageContext` and the assertion passed for the wrong reason. The
   reviewer judged it test tightness rather than a hole; tightened anyway, and the
   expect count moving 303 → 306 is the proof the assertions now run.

### What did not improve (LOOP-PESSIMIST-01)

- **The catalog remains unable to prevent this class of failure.** `support_verbosity: false`
  is correct and was already correct while the 400s were happening. It cannot reach a
  client holding a cached catalog, and it does not govern `text.format: {"type":"text"}`
  at all. This unit did not fix that, and no capability flag will.
- **The translated `adapters.md` locales still lack the new bullet** — as they already
  lacked the `parallel_tool_calls` one. They do not contradict the English source, so
  this is drift, not a defect, and it was left alone rather than half-fixed.
- **Evidence that this direction is wrong, if it appears:** a Kiro turn that carries a
  `text` member the wire genuinely cannot ignore. The guard is now a denylist of one
  concept rather than an allowlist of none, so such a member would need its own
  condition. Nothing in OpenAI's current `ResponseTextConfig` (`format`, `verbosity`)
  is such a member.

### Deferred, deliberately

Both observed in the same `service.log` while diagnosing, both out of scope:

- Kiro OAuth refresh repeating (54 `OAuth refresh started provider=kiro` entries).
- Cursor model discovery failing over to a stale catalog and dropping 13 configured
  model ids.

