# 020 — Bug B: DeepSeek service_tier capability gate (#860) + reasoning replay fix (#875)

Consumed by work-phase wp-b. Re-verify against the current tree at wp-b's P (wt2 #847 may have touched the same files by then — see coordination note).

## Research findings (2026-08-02, sol-medium researcher, sources cited inline)

- PR #860's capability design fits this tree and applies cleanly (`git apply --check` passed on dev@478354ee8's lineage). Its file map is adopted below with two corrections from its open review threads: the canonical-`openai` test must prove REGISTRY BACKFILL (not hardcode the field), and ja/zh docs must not keep contradictory blanket wording.
- Official DeepSeek Responses docs list `service_tier` as unsupported but say unsupported Responses parameters are SILENTLY IGNORED (api-docs.deepseek.com/guides/responses_api/). Stripping remains sensible compatibility policy, but **`service_tier` cannot explain #875's stall** — the ledger in `000_plan.md` is updated accordingly.
- #875 root cause (local, separate from #860): the continuation store preserves reasoning items (`src/responses/state.ts:699`, `:806`, `:837`; recorder installed at `src/server/responses/core.ts:1554`), DeepSeek stateless cleanup (`src/adapters/openai-responses.ts:1003`) does not remove them, but then `sanitizeReasoningInputContent()` (`src/adapters/openai-responses.ts:35`, blanks every non-empty reasoning item's `content` to `[]` at :45-56) is invoked at `:1027` for EVERY Responses provider. The function is OpenAI/ChatGPT-backend-motivated but unscoped. The local schema explicitly supports plaintext `{type:"reasoning_text"}` (`src/responses/schema.ts:23`, `:52`), and DeepSeek's native Responses contract accepts plaintext reasoning content — so current ocx deterministically sends DeepSeek an emptied reasoning item on every continuation. DeepSeek's registry `preserveReasoningContentModels` protects only Chat-Completions serialization, not native passthrough.
- Caveat recorded: this defect only fires once a follow-up request REACHES ocx; it cannot by itself explain #875's "no follow-up HTTP request sent at all" observation, which may be a separate client/SSE handoff issue. #875 stays open with a comment; the reasoning replay defect is fixed here as the local half.

## File map

- MODIFY `src/types.ts` — provider-level `supportsServiceTier` capability field (optional; tri-state semantics: `true` inject/strip allowed, `false` strip always, `undefined` preserve caller value).
- MODIFY `src/config.ts` — accept the field in persisted provider configuration (per #860's config.ts:482 hunk).
- MODIFY `src/providers/registry.ts` — registry-enriched metadata: canonical OpenAI Responses providers = `true`, DeepSeek = `false`. Capability is runtime metadata so older canonical OpenAI configs stay valid.
- MODIFY `src/providers/derive.ts` — carry the value into key-login metadata; fill missing values during registry enrichment WITHOUT overriding explicit config.
- MODIFY `src/router.ts` — independent backfill on the final routed provider (covers stale/minimal saved configs).
- MODIFY `src/server/responses/core.ts` (:806-807 on dev@478354ee8) — `fastMode` currently does `if (tier) _rawBody.service_tier = tier; else delete ...` gated only by adapter kind. Consult the provider capability: inject/remove only for `true`; always delete for `false`; leave caller-supplied values untouched for `undefined`.
- MODIFY `src/adapters/openai-responses.ts` — TWO changes: (1) `service_tier` decision happens in core.ts after final adapter resolution; the adapter stays provider-agnostic (commentary only, per #860). (2) NEW for #875: scope `sanitizeReasoningInputContent()` so it no longer blanks reasoning content for providers whose native contract accepts plaintext reasoning (DeepSeek first). Mechanism decision at B: provider-capability flag vs explicit provider-id check — prefer a registry capability to avoid a second provider-fact location (src/AGENTS.md: provider catalog metadata belongs in the registry).
- DOCS: configuration reference EN + zh-CN (docs-site) — the capability and the DeepSeek behavior; ja locale must not contradict.

## Acceptance + activation scenarios

1. DeepSeek Responses request never carries `service_tier`, including with `fastMode` on. Activation: serialized-payload test with a DeepSeek provider config + fastMode, asserting the field is absent from `_rawBody`.
2. Canonical OpenAI Responses provider keeps inject/remove behavior. Activation: payload test asserting `service_tier` present with fastMode on, absent with off.
3. Unclassified custom Responses provider preserves a caller-supplied `service_tier`. Activation: payload test with pre-set field asserting pass-through.
4. Older canonical OpenAI configs without the capability field still behave as today. Activation: backward-compat test with legacy config shape.
5. Registry backfill is proven, not hardcoded: a provider config WITHOUT the field gets the registry value at derive/router boundaries. Activation: test asserting the enriched value appears with the field absent from config (addresses #860's open review issue).
6. #875 regression: a continuation request carrying a plaintext reasoning item (`{type:"reasoning", content:[{type:"reasoning_text", text:...}]}`) through a DeepSeek Responses route keeps its reasoning content on the wire. Activation: adapter serialization test asserting non-empty content after `sanitizeReasoningInputContent` for DeepSeek, and emptied content for the OpenAI/ChatGPT path (unchanged behavior there).

## #875 triage verdict (recorded, discharge of the obligation)

Verdict: **separate local bug, fixed in this cycle** (reasoning replay deletion above) + **residual external piece** (the "no follow-up request at all" observation cannot be explained by any ocx code path found; may be client/SSE handoff or NIM/vLLM-side). Action at D: comment on #875 with the file:line evidence and the remaining unexplained piece; do NOT close #875 as fixed-by-#860.


## Cross-worktree coordination (wt2 #847)

Both this fix and wt2 #847 touch `src/adapters/openai-responses.ts` and `src/server/responses/core.ts` (different code paths: SSE/tool-arg caps vs `service_tier` injection). Whichever lands second rebases and re-runs its payload-shape tests.
