# 020 — Bug B: DeepSeek service_tier capability gate (#860) + reasoning replay fix (#875)

Consumed by work-phase wp-b. Stale-checked against codex/wt3-exec after wp-a landed (wp-a touched only the github-copilot entry of registry.ts; no overlap with this file map).

## P-phase decisions (2026-08-02, verified in code)

- **service_tier semantics follow #860's REVIEWED final head, not its original body**: `supportsServiceTier === true` → fastMode injects/removes (fastMode unset preserves caller value); `false` OR `undefined` → strip caller value and never inject (fail closed — the owner's "fail-open unknowns" blocker). Escape hatch for custom providers that genuinely support tiers: explicit `supportsServiceTier: true` in the provider config (explicit config always wins over registry backfill). This supersedes the earlier "preserve caller-supplied values for unclassified custom providers" wording.
- **Reasoning replay mechanism**: new provider-level flag `preserveResponsesReasoningContent` (registry + persisted config + derive/router backfill, exactly the `statelessResponses` flow: config.ts:484 zod, derive.ts:139/:236/:260, router.ts:259). `sanitizeReasoningInputContent(body, opts?)` gains an options param defaulting to current behavior; when the flag is set it still strips ocxr1 envelopes (proxy-minted Anthropic signatures no upstream can decrypt) but does NOT blank plaintext reasoning content. Existing callers (`compact.ts:255` and friends) pass nothing → unchanged behavior. Registry sets the flag on `deepseek`.
- service_tier also flows through `parsed.options.serviceTier` (parser.ts:618) — stripping must clear the raw body field; options.logging follows existing behavior.

## Research findings (2026-08-02, sol-medium researcher, sources cited inline)

- PR #860's capability design fits this tree and applies cleanly (`git apply --check` passed on dev@478354ee8's lineage). Its file map is adopted below with two corrections from its open review threads: the canonical-`openai` test must prove REGISTRY BACKFILL (not hardcode the field), and ja/zh docs must not keep contradictory blanket wording.
- Official DeepSeek Responses docs list `service_tier` as unsupported but say unsupported Responses parameters are SILENTLY IGNORED (api-docs.deepseek.com/guides/responses_api/). Stripping remains sensible compatibility policy, but **`service_tier` cannot explain #875's stall** — the ledger in `000_plan.md` is updated accordingly.
- #875 root cause (local, separate from #860): the continuation store preserves reasoning items (`src/responses/state.ts:699`, `:806`, `:837`; recorder installed at `src/server/responses/core.ts:1554`), DeepSeek stateless cleanup (`src/adapters/openai-responses.ts:1003`) does not remove them, but then `sanitizeReasoningInputContent()` (`src/adapters/openai-responses.ts:35`, blanks every non-empty reasoning item's `content` to `[]` at :45-56) is invoked at `:1027` for EVERY Responses provider. The function is OpenAI/ChatGPT-backend-motivated but unscoped. The local schema explicitly supports plaintext `{type:"reasoning_text"}` (`src/responses/schema.ts:23`, `:52`), and DeepSeek's native Responses contract accepts plaintext reasoning content — so current ocx deterministically sends DeepSeek an emptied reasoning item on every continuation. DeepSeek's registry `preserveReasoningContentModels` protects only Chat-Completions serialization, not native passthrough.
- Caveat recorded: this defect only fires once a follow-up request REACHES ocx; it cannot by itself explain #875's "no follow-up HTTP request sent at all" observation, which may be a separate client/SSE handoff issue. #875 stays open with a comment; the reasoning replay defect is fixed here as the local half.

## File map

- MODIFY `src/types.ts` — `OcxProviderConfig.supportsServiceTier?: boolean` and `OcxProviderConfig.preserveResponsesReasoningContent?: boolean`.
- MODIFY `src/config.ts` — zod: both fields optional booleans beside `statelessResponses` (:484).
- MODIFY `src/providers/registry.ts` — `ProviderRegistryEntry` gains both fields; `openai` + `openai-apikey` get `supportsServiceTier: true`; `deepseek` gets `supportsServiceTier: false` AND `preserveResponsesReasoningContent: true`; `volcengine-agent-plan` gets `supportsServiceTier: false` (per #860's reviewed head).
- MODIFY `src/providers/derive.ts` — seed pass-through + backfill for both fields (the :139/:236/:260 pattern); never override explicit config.
- MODIFY `src/router.ts` — final-route backfill for both fields (:259 pattern) covering stale/minimal saved configs.
- MODIFY `src/server/responses/core.ts:803-808` — consult the effective capability: `true` keeps today's fastMode inject/remove (unset fastMode preserves caller); `false`/`undefined` always strip `_rawBody.service_tier` and never inject.
- MODIFY `src/adapters/openai-responses.ts` — `sanitizeReasoningInputContent(body, { preserveRawReasoningContent })`; call site (:1027 chain) passes the provider flag. Comment must name the contract: ChatGPT's native backend requires empty reasoning content; DeepSeek's native contract accepts plaintext reasoning and REQUIRES it on tool-call continuations.
- NEW `tests/service-tier-capability.test.ts` + reasoning replay cases in `tests/deepseek-inbound-wire.test.ts` (or a new focused file — decide by sibling proximity at B).
- DOCS `docs-site/src/content/docs/reference/configuration/providers.md` + ko/ja/zh-cn/ru — `supportsServiceTier` and `preserveResponsesReasoningContent` rows; ja/zh-cn must not keep contradictory blanket service-tier wording (#860 open review issue).

## Acceptance + activation scenarios

1. DeepSeek Responses request never carries `service_tier`, including with `fastMode` on. Activation: serialized-payload test with a DeepSeek provider config + fastMode, asserting the field is absent from `_rawBody`.
2. Canonical OpenAI Responses provider keeps inject/remove behavior. Activation: payload test asserting `service_tier` present with fastMode on, absent with off.
3. Unclassified custom Responses provider FAILS CLOSED: a caller-supplied `service_tier` is stripped, never injected. Activation: payload test asserting absence. Escape hatch: the same provider with explicit `supportsServiceTier: true` in config preserves/injects. Activation: second payload test.
4. Older canonical OpenAI configs without the capability field still behave as today. Activation: backward-compat test with legacy config shape.
5. Registry backfill is proven, not hardcoded: a provider config WITHOUT the field gets the registry value at derive/router boundaries. Activation: test asserting the enriched value appears with the field absent from config (addresses #860's open review issue). An explicit config value beats the registry default in both directions. Activation: override tests.
6. #875 regression: a continuation request carrying a plaintext reasoning item (`{type:"reasoning", content:[{type:"reasoning_text", text:...}]}`) through a DeepSeek Responses route keeps its reasoning content on the wire. Activation: adapter serialization test asserting non-empty content after `sanitizeReasoningInputContent` for DeepSeek, and emptied content for the OpenAI/ChatGPT path (unchanged behavior there).

## #875 triage verdict (recorded, discharge of the obligation)

Verdict: **separate local bug, fixed in this cycle** (reasoning replay deletion above) + **residual external piece** (the "no follow-up request at all" observation cannot be explained by any ocx code path found; may be client/SSE handoff or NIM/vLLM-side). Action at D: comment on #875 with the file:line evidence and the remaining unexplained piece; do NOT close #875 as fixed-by-#860.


## Cross-worktree coordination (wt2 #847)

Both this fix and wt2 #847 touch `src/adapters/openai-responses.ts` and `src/server/responses/core.ts` (different code paths: SSE/tool-arg caps vs `service_tier` injection). Whichever lands second rebases and re-runs its payload-shape tests.
