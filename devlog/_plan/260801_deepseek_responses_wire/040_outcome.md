# 040 — Outcome

Terminal outcome: **DONE**. All six criteria proven by fresh command output on the
landed tree.

## What shipped

| Commit | Change |
|---|---|
| `3b379fbee` | Research unit; MIT DSCodex reference clone isolated from history |
| `bafb2e31a` | Diff-level roadmap |
| `199b34486` | First audit folded back |
| `2cccfda29` | **Phase 1** — `responsesPath` so the wire routes to `POST /responses` |
| `54319d1f2` | Second audit folded back |
| `9adf58a04` | **Phase 2** — inbound-scoped wire default |
| `a37fb4912` | Third audit folded back |
| `c5fc88828` | **Phase 3** — stateless request sanitisation + orphan repair |

These interleave with unrelated maintainer work on the same branch (the RSS-retention
fixes and the `origin/dev` merge at `30fb76856` carrying PRs #750 and #751). The
full-suite run below is a descendant of that merge, so its result covers the combined
tree rather than this unit in isolation.

## Criteria

| id | status | evidence |
|---|---|---|
| C1 | met | seeded deepseek builds `https://api.deepseek.com/responses`; negative control keeps `/v1/responses` elsewhere |
| C2 | met | Responses inbound → `openai-responses`, proven end-to-end by captured upstream URL |
| C3 | met | Anthropic inbound → `openai-chat`, same proof |
| C4 | met | Chat inbound → `openai-chat`, same proof |
| C5 | met | five stateful params dropped, `store` pinned, negative control proves capability gating |
| C6 | met | `bun run test` 6469 pass / 3 skip / 0 fail across 464 files; `tsc --noEmit` clean; `privacy:scan` green |

Both new test groups were checked for vacuity by ablation rather than assumed:
reverting the registry scope to a bare string turned 4 of 9 wire tests red on the
exact wrong URL, and reverting the orphan-repair gate to forward-only turned exactly
one test red. Restoring each returned green.

## What the audits changed

Three review rounds, each finding something the plan would otherwise have shipped:

1. **Critical.** Phase 2's first draft edited only the pre-flight
   `resolveWireProtocolOverride` calls in `claude-messages.ts` and
   `chat-completions.ts`. Both surfaces replay through `handleResponses`, where the
   wire is really settled, so the edit would have changed nothing — and would have
   left the two layers disagreeing, leaking `temperature`/`top_p` to a Responses
   upstream. The inbound now travels through `HandleResponsesOptions`.
2. **Medium.** `CodexPoolAccountRetryArgs.options` is a narrowed structural type, so
   the planned read would not have compiled. The end-to-end criterion also named a
   non-exported function as its test seam; replaced with the captured upstream URL.
3. **High.** Dropping stateful parameters was not sufficient. On a replay miss the
   delta can open with a `function_call_output` whose pair sat in the un-expanded
   prefix, and `repairOrphanedInputItems` ran only for forward providers — trading a
   rejected parameter for an unparseable body.

## Deliberate non-changes

- **`service_tier` is still forwarded.** The server writes it for fast mode, and
  deleting a configured knob inside an adapter is action-at-a-distance. Whether
  DeepSeek rejects it is UNVERIFIED — no API key was available, so no authenticated
  probe was possible.
- **No `deepseek-v4-pro` wiring.** Upstream states it is not supported on the
  Responses API yet.
- **DSCodex code was not copied.** `fish2lab/DSCodex` (MIT) was read for its
  request-sanitisation list only. Its clone is gitignored and guarded by
  `tests/repo-hygiene.test.ts`. Its effort fold (`high`/`max`) was deliberately not
  copied: DeepSeek accepts the full `none…max` range, which the registry already
  exposes.

## Known follow-up

`core.ts:773` applies `service_tier` by wire shape (`adapter === "openai-responses"`)
rather than by provider capability. Phase 2 widened that set to include DeepSeek. The
correct fix narrows the write site; it was left out of scope here rather than expanded
into mid-phase.

## Not pushed

Eight commits sit on local `dev`. Pushing needs explicit approval and was not given.
