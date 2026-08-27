# 002 — Audit round 1: findings and plan amendments

Reviewer: independent \`explorer\` subagent on \`xai/grok-4.6\` (decorrelated from
the planning model, REVIEW-DECORRELATE-01). Read-only. 2026-08-27.

**VERDICT: GO-WITH-FIXES (blockers=3)** — all three Medium, all three folded.
Every finding was re-verified by the main agent before acceptance; none was
taken on the reviewer's word.

## Blocker 1 — stale comments will misdescribe the guard (folded)

\`src/server/responses/core.ts:3094-3096\`:

    // the raw \`text\` controls go too: Kiro's capability guard reads both and would reject
    // the turn outright, and the key-mode openai-responses adapter builds from _rawBody.

And \`tests/server-kiro-completion-e2e.test.ts:237-238\`:

    // Routed compaction must strip the structured-output request; before the strip,
    // Kiro's capability guard rejected the whole turn as unsupported text controls.

Both re-read and confirmed by the main agent. After the narrowing, "Kiro's
capability guard reads both" is false: the guard reads \`_structuredOutput\`
only. A comment that names a behavior the code no longer has is worse than no
comment — the next reader trusts it.

**Amendment.** \`010\` gains a comment-only edit to both files. The three
deletions at \`core.ts:3098-3102\` **stay**: the reviewer confirmed, and the main
agent verified via \`4d1e9fcb2\` (*fix(responses): strip all structured-output
traces from routed compaction*), that \`_rawBody.text\` deletion remains
load-bearing for the key-mode \`openai-responses\` adapter, pinned by
\`tests/responses-compaction-routing.test.ts:607\`. Only the justification
changes, not the behavior.

This narrows the \`000\` scope boundary, which listed \`core.ts\` as OUT. The
boundary was written to protect the Lab-import invariant \`AGENTS.md\` guards;
a comment edit touches no import and no code path, so the invariant is intact.
Recorded explicitly rather than silently widened.

## Blocker 2 — the wire-absence assertion was sloppy (folded)

\`010\` proposed \`expect(serialized).not.toContain("verbosity")\` — a substring
scan of the whole JSON body. Two failure modes, both real:

- **False fail:** any later fixture whose prose happens to contain the word.
- **False confidence:** a control forwarded under a different key would pass,
  since only top-level \`payload.text\` was otherwise checked.

The sibling test added by \`db040e70f\` already shows the right shape
(\`tests/kiro-adapter.test.ts:936-941\`): assert the specific key absent at
\`payload\`, \`conversationState\`, and \`userInputMessageContext\`.

**Amendment.** \`010\`'s test drops the substring scan and mirrors that pattern.
Better in kind, not merely stricter: it names where the control could appear
instead of hoping a word does not.

## Blocker 3 — the verifier claim was wrong (folded)

\`000\` claimed \`tsconfig.json\` \`include\` covers \`src/\` and \`tests/\`. It does not:

    "include": ["src"]

\`bun x tsc --showConfig\` confirms, and \`noUnusedLocals\` is unset — TypeScript's
\`strict\` does not imply it. Two consequences the plan got wrong:

1. \`tsc\` does **not** typecheck the new tests. Only \`bun test\` proves them.
2. Leaving the dead \`raw\` local would **not** fail typecheck. It is still
   deleted — dead code — but not for the stated reason.

This is exactly the failure PLAN-VERIFIER-REAL-01 exists to catch: the command
was run and its exit code recorded, but the *reads-the-target* claim was
asserted from the config's reputation rather than its contents. The rule asks
for the \`include\` entry to be quoted. It was not, and the claim was false.

**Amendment.** \`000\`'s verifier table is corrected below and \`010\`'s rationale
for deleting \`raw\` is restated as dead-code hygiene. \`docs-site\` gets its own
build check since \`010\` edits it.

### Corrected verifier table

| Command | Exit | Reads this unit's target? |
|---|---|---|
| \`bun install\` | 0 | Prerequisite; without it \`bun test\` dies with \`Cannot find module 'zod/v4'\`. |
| \`bun test tests/kiro-adapter.test.ts\` | 0 (56 pass) | **Yes** — direct path argument; imports \`../src/adapters/kiro\`. |
| \`bun x tsc --noEmit\` | to capture | **Partly** — \`tsconfig.json\` \`"include": ["src"]\` covers \`src/adapters/kiro.ts\` but **not** \`tests/\`. |
| \`bun run test\` | to capture | **Yes** — full \`tests/\` suite; required by \`AGENTS.md\` for shared adapter surfaces. |
| \`cd docs-site && bun run build\` | to capture | **Yes** — \`010\` edits \`docs-site/src/content/docs/reference/adapters.md\`. |
| \`gh pr checks <n>\` | wp3 | **Yes** — CI at the pushed head SHA. |

## Reviewer findings accepted as confirmation, not amendment

Independently re-verified by the main agent:

- The throw string appears in exactly two places — \`src/adapters/kiro.ts:326\`
  and \`tests/kiro-adapter.test.ts:895\`. \`010\` already updates both. No miss.
- \`_structuredOutput\` has exactly one production writer
  (\`src/responses/parser.ts:817\`) and one clearer
  (\`src/server/responses/core.ts:3099\`). Confirmed by \`rg\`.
- \`buildKiroPayload\` never spreads \`_rawBody\`; \`rg _rawBody src/adapters/kiro.ts\`
  returns only the guard local. The no-stripping-needed claim holds.
- \`src/web-search/loop.ts:745\` only picks JSON vs markdown for sidecar results.
  Unaffected.
- \`parseRequest\` is imported at \`tests/kiro-adapter.test.ts:15\`;
  \`kiro/claude-haiku-4.5\` is already exercised at \`:904\`.
- All three shapes throw against the current guard — the activation evidence
  will be real.
- \`dev\` is the correct base; the gui-screenshot rule does not apply.

## Why the presence check survived so long

The reviewer traced it, and the main agent confirmed the chain:

- \`df31ca4aba\` (2026-07-22) introduced it alongside the parallel-tool refusal,
  with no rationale.
- \`ea6ff8fe62\` added the capability test — but pinned only
  \`_structuredOutput: true\`, never the raw-\`text\` disjunct. The over-broad half
  was **never covered by a test**, which is why it survived \`db040e70f\`'s
  cleanup of its neighbour.
- \`4d1e9fcb2\` then wrote code *around* it: routed compaction deletes
  \`_rawBody.text\` partly to satisfy this guard, which made the disjunct look
  load-bearing.

An untested branch that other code defends against reads as intentional. It was
not; it was a leftover from before \`parseTextFormat\` existed to tell the two
concepts apart.

## External contract check

The reviewer verified against upstream rather than from memory: OpenAI's
\`ResponseTextConfig\` carries exactly \`format\` and \`verbosity\`, with \`format\` one
of \`text\` | \`json_schema\` | \`json_object\` (openai-python
\`response_text_config_param.py\`, fetched 2026-08-27). So the tolerated set is
closed at today's contract, and refusing structured output — rather than
silently degrading to prose — is the honest disposition.

