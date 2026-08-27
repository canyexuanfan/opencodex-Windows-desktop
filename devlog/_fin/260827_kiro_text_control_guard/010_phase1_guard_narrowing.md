# 010 — Phase 1 (wp2): narrow the guard, prove both directions

Diff-level. Copy-paste executable. Re-verify against the tree before building
(the P of wp2 does the stale check).

## Change map

| Path | Action | Why |
|---|---|---|
| \`src/adapters/kiro.ts\` | MODIFY | Narrow \`validateKiroCapabilities\` to structured output only |
| \`tests/kiro-adapter.test.ts\` | MODIFY | Regression both directions + wire-absence assertion |
| \`docs-site/src/content/docs/reference/adapters.md\` | MODIFY | User-facing contract |
| \`structure/04_transports-and-sidecars.md\` | MODIFY | Decision log next to the sibling entry |
| \`src/server/responses/core.ts\` | MODIFY (comment only) | Its comment names the guard's old behavior |
| \`tests/server-kiro-completion-e2e.test.ts\` | MODIFY (comment only) | Same stale claim |

The two comment-only edits were added by audit round 1 (\`002\`). They change no
code path and no import, so the Lab-boundary invariant \`AGENTS.md\` protects in
\`core.ts\` is untouched — but \`000\` listed that file as OUT, so the narrowing of
the scope boundary is recorded rather than assumed.

## 1. \`src/adapters/kiro.ts\`

Current, at \`:316-328\`:

    function validateKiroCapabilities(parsed: OcxParsedRequest): void {
      const choice = parsed.options.toolChoice;
      if (choice !== undefined && choice !== "auto" && choice !== "none") {
        throw new Error("Kiro supports only automatic tool choice or tool_choice:none");
      }
      if (parsed.options.serviceTier !== undefined) {
        throw new Error("Kiro does not support service tiers");
      }
      const raw = parsed._rawBody as Record<string, unknown> | undefined;
      if (parsed._structuredOutput || raw?.text !== undefined) {
        throw new Error("Kiro does not support Responses text controls or structured output");
      }
    }

After:

    function validateKiroCapabilities(parsed: OcxParsedRequest): void {
      const choice = parsed.options.toolChoice;
      if (choice !== undefined && choice !== "auto" && choice !== "none") {
        throw new Error("Kiro supports only automatic tool choice or tool_choice:none");
      }
      if (parsed.options.serviceTier !== undefined) {
        throw new Error("Kiro does not support service tiers");
      }
      // Structured output is a real contract Kiro cannot honour: the wire has no
      // schema-constrained response mode, so a caller expecting parseable JSON would
      // get prose and fail downstream. Refuse it.
      //
      // The rest of the Responses \`text\` object is NOT that. \`text.verbosity\` is a
      // length preference and \`text.format: {type:"text"}\` is ordinary prose — the
      // default output mode, which no capability flag governs and every correct client
      // may send. Refusing the mere PRESENCE of \`text\` turned both into 400s
      // (usage.jsonl, 2026-08-27: kiro/claude-opus-5 turns rejected with sendCount 0
      // between successful ones). That is the same mistake db040e70f removed one
      // condition earlier, where a permissive \`parallel_tool_calls\` hint was read as a
      // requirement.
      //
      // Nothing needs stripping the way openai-responses strips a no-op verbosity:
      // buildKiroPayload composes conversationState field by field from \`parsed\` and
      // never spreads \`_rawBody\`, so a tolerated control is dropped by construction.
      // The test asserts that absence so it stays true.
      if (parsed._structuredOutput) {
        throw new Error("Kiro does not support Responses structured output");
      }
    }

Notes:

- \`_structuredOutput\` is set by \`parseTextFormat\` for \`json_schema\` and
  \`json_object\` only (\`src/responses/parser.ts:817\`, verified in \`000\`).
- The \`raw\` local becomes unused and is deleted as dead code. Note (audit round 1,
  \`002\`): this is hygiene, **not** a typecheck requirement — \`tsconfig.json\` sets
  \`"include": ["src"]\` with \`noUnusedLocals\` unset, and \`strict\` does not imply it,
  so leaving \`raw\` would compile. Delete it anyway; a local read by nothing is a
  false clue for the next reader.
- **The message changes**, dropping "text controls or". It is now accurate: only
  structured output is refused. \`tests/kiro-adapter.test.ts:895\` asserts the old
  string and must be updated in the same commit — do not leave the stale
  substring to keep a test green.

## 2. \`tests/kiro-adapter.test.ts\`

### 2a. Update the existing assertion (~\`:893-896\`)

    await expect(createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "hi" }], [bashTool]),
      _structuredOutput: true,
    } as OcxParsedRequest)).rejects.toThrow("Kiro does not support Responses structured output");

Only the expected message changes; the case still belongs.

### 2b. New test — the regression

Insert after the \`validates Kiro request capabilities explicitly\` test, beside
the parallel-tool-hint test that shares its shape. Uses \`parseRequest\` so the
real parser produces \`_structuredOutput\` and \`_rawBody\` rather than a hand-built
object — the hand-built path is what let this defect hide.

    test("tolerates non-structured Responses text controls and keeps them off the Kiro wire", async () => {
      // Regression: the guard used to reject the PRESENCE of any \`text\` member, so a
      // verbosity hint or a plain \`format: {type:"text"}\` produced HTTP 400 while the
      // identical turn without \`text\` succeeded (usage.jsonl, 2026-08-27).
      for (const text of [
        { verbosity: "medium" },
        { format: { type: "text" } },
        {},
      ]) {
        const parsed = parseRequest({
          model: "kiro/claude-haiku-4.5",
          input: "test",
          stream: true,
          text,
        } as never);
        expect(parsed._structuredOutput ?? false).toBe(false);
        expect((parsed._rawBody as Record<string, unknown>).text).toBeDefined();

        const built = await createKiroAdapter(provider).buildRequest(parsed);
        const payload = JSON.parse(built.body) as {
          text?: unknown;
          verbosity?: unknown;
          conversationState?: {
            text?: unknown;
            verbosity?: unknown;
            currentMessage: {
              userInputMessage: {
                userInputMessageContext?: { text?: unknown; verbosity?: unknown };
              };
            };
          };
        };

        // Reached the wire at all — the point of the fix.
        expect(payload.conversationState).toBeDefined();
        // ...but the control itself is not forwarded: Kiro has no field for it.
        // Assert per key at each level the Kiro payload actually has, mirroring the
        // parallel-tool test at tests/kiro-adapter.test.ts:936. A substring scan of the
        // serialized body was rejected in audit round 1 (002): it false-fails on any
        // fixture containing the word, and false-passes a control forwarded under
        // another key.
        const context = payload.conversationState?.currentMessage.userInputMessage
          .userInputMessageContext;
        for (const level of [payload, payload.conversationState, context]) {
          expect(level?.text).toBeUndefined();
          expect(level?.verbosity).toBeUndefined();
        }
      }
    });

    test("still refuses genuine structured output", async () => {
      for (const text of [
        { format: { type: "json_schema", name: "r", schema: { type: "object" } } },
        { format: { type: "json_object" } },
      ]) {
        const parsed = parseRequest({
          model: "kiro/claude-haiku-4.5",
          input: "test",
          stream: true,
          text,
        } as never);
        expect(parsed._structuredOutput).toBe(true);
        await expect(createKiroAdapter(provider).buildRequest(parsed))
          .rejects.toThrow("Kiro does not support Responses structured output");
      }
    });

\`parseRequest\` is already imported (added by \`db040e70f\`); confirm before adding.

### 2c. Activation evidence (A8, C-ACTIVATION-GROUNDING-01)

Before applying the \`src\` change, run the new tests against the **current**
guard. The first must fail on all three shapes; the second must fail only on the
message text. Record both tails in the wp2 attestation. A test that passes
before and after proves nothing about the branch.

## 3. \`docs-site/src/content/docs/reference/adapters.md\`

In the Kiro bullet list, after the \`parallel_tool_calls\` bullet added by
\`db040e70f\`:

    - Accepts Responses \`text\` controls that are not structured output — \`text.verbosity\`
      and \`text.format: {"type":"text"}\` — without forwarding them. Kiro has no wire field
      for either, so they are ignored rather than rejected. Structured output
      (\`text.format\` of type \`json_schema\` or \`json_object\`) is still refused, because the
      Kiro wire cannot constrain the response shape and a caller expecting JSON would
      receive prose.

## 4. \`structure/04_transports-and-sidecars.md\`

Directly after the *Kiro client parallel-tool hint* section, matching its
Decision Log format:

    ## Kiro Responses text controls

    Kiro refuses structured output and tolerates every other Responses \`text\` member.
    \`text.format\` of type \`json_schema\` or \`json_object\` is a contract the CodeWhisperer
    wire cannot honour, so the adapter rejects it rather than returning prose to a caller
    expecting JSON. \`text.verbosity\` and \`text.format: {"type":"text"}\` are preferences,
    not contracts; they are accepted and dropped, because \`buildKiroPayload\` composes
    \`conversationState\` from parsed fields and never forwards the raw body.

    [Decision Log]
    - 목적과 의도: Stop rejecting valid Kiro turns whose only offence is carrying a Responses text control the wire ignores.
    - 기존 구현 및 제약 조건: The guard tested \`_rawBody.text !== undefined\`, so \`text.verbosity\`, \`text.format:{"type":"text"}\`, and even \`text:{}\` produced HTTP 400 with sendCount 0; \`_structuredOutput\` already distinguishes real structured output, and the catalog's \`support_verbosity: false\` cannot help a cached client or govern the default text format at all.
    - 검토한 주요 대안: Keep the presence check, add an openai-responses-style stripper before serialization, or narrow the guard to \`_structuredOutput\` alone.
    - 선택한 방식: Narrow the condition to \`_structuredOutput\`; no stripper is needed because the Kiro payload never spreads the raw body.
    - 다른 대안 대신 이 방식을 선택한 이유: The presence check reads a preference as a requirement — the same error \`db040e70f\` removed for parallel-tool hints — and a stripper would add a serialization stage to defend a body Kiro already ignores by construction.
    - 장점, 단점 및 영향: Kiro-routed Codex turns stop failing intermittently; structured output stays honestly refused; a future \`text\` member Kiro genuinely cannot ignore would need its own condition.

## 5. Stale comments (comment-only, from audit round 1)

Both files describe the guard's *old* behavior. Neither deletion changes; only
the justification, because after this unit "Kiro's capability guard reads both"
is false — it reads \`_structuredOutput\` alone.

\`src/server/responses/core.ts:3094-3096\`, current:

    // would force schema-constrained JSON into the synthetic compaction item. The flag and
    // the raw \`text\` controls go too: Kiro's capability guard reads both and would reject
    // the turn outright, and the key-mode openai-responses adapter builds from _rawBody.

After:

    // would force schema-constrained JSON into the synthetic compaction item. The flag goes
    // too, and so does the raw \`text\` control — the key-mode openai-responses adapter
    // serializes from _rawBody, so a surviving format there would reach the upstream.
    // (The Kiro guard no longer reads _rawBody.text; it refuses structured output only.)

**Keep all three deletions.** \`4d1e9fcb2\` added them and
\`tests/responses-compaction-routing.test.ts:607\` asserts \`sent.text\` is
undefined for the key-mode adapter, so \`_rawBody.text\` deletion stays
load-bearing independently of Kiro.

\`tests/server-kiro-completion-e2e.test.ts:237-238\`, current:

    // Routed compaction must strip the structured-output request; before the strip,
    // Kiro's capability guard rejected the whole turn as unsupported text controls.

After:

    // Routed compaction must strip the structured-output request: the Kiro guard refuses
    // structured output, and a surviving json_schema would constrain a prose summary.

The test body is unchanged — it sends a real \`json_schema\`, which this unit
keeps refusing.

## Commits (DEV-GIT-COMMIT-01)

1. \`test(kiro): pin non-structured Responses text controls\` — tests only,
   demonstrably failing. This is the activation evidence, committed before the
   fix so the history shows the defect reproduced.
2. \`fix(kiro): reject only genuine structured output\` — the \`src\` change plus the
   \`:895\` message update. Suite green.
3. \`docs(kiro): document Responses text control handling\` — docs-site + structure.
   Includes the two comment-only corrections from §5.

## Verification for wp2's C

    bun test tests/kiro-adapter.test.ts     # expect > 56 pass, 0 fail
    bun x tsc --noEmit                       # expect exit 0
    bun run test                             # full suite — AGENTS.md, shared adapter surface
    cxc receipt test                         # receipt path for the C>D attest

\`tsc\` covers \`src\` only (\`"include": ["src"]\`), so it proves the adapter change,
not the tests; \`bun test\` is what proves those. Add
\`cd docs-site && bun run build\` because §3 edits docs-site.

Plus a live replay against the operator's running proxy for the three shapes
that returned 400 on 2026-08-27 — a genuine end-to-end confirmation, though the
deployed \`2.33.0\` will still carry the old guard until this ships, so the replay
is recorded as a *pre-fix baseline* there and re-run against a locally started
build.

## Out of scope, restated

No change to \`src/router.ts\`, \`src/server/lifecycle.ts\`, or
\`src/server/responses/core.ts\` — the three files \`AGENTS.md\` protects from Lab
imports. No credential, OAuth, workflow, or release path. No \`devlog/\` security
material.
