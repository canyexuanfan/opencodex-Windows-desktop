# 010 — Classify NVIDIA NIM vision capability by its short side (#964 / issue #956)

## The defect being fixed

The registry `nvidia` entry declares no `noVisionModels`
(`src/providers/registry.ts:1303-1320`), so `planVisionSidecar()` returns
`undefined` for every NIM model (`src/vision/index.ts:235`). A text-only NIM
model therefore either receives raw image parts it cannot read, or — more often —
has attachments blocked client-side because the catalog never advertises image
input (`src/codex/catalog/provider-fetch.ts:177-184`). That is issue #956, and it
is real.

Note the field's inverted name: `noVisionModels` lists models that CANNOT see
images, and listing one there is what *enables* image support for it, via the
sidecar. Getting a model's membership wrong in either direction is a bug.

## Why #964's list cannot be carried

#964 enumerates ~60 text-only NIM ids by hand. Live verification against
NVIDIA's own documentation on 2026-08-04 found **five of those entries are
natively image-capable**:

| Id | #964 says | NVIDIA says | Source |
|---|---|---|---|
| `thinkingmachines/inkling` | text-only | text, **image**, audio (RGB, 40–4096px per side) | [NIM API reference](https://docs.api.nvidia.com/nim/reference/thinkingmachines-inkling) |
| `minimaxai/minimax-m3` | text-only | Text, **Image**, Video | build.nvidia.com model page |
| `moonshotai/kimi-k2.6` | text-only | text, **image**, video, with a published `image_url` example | build.nvidia.com model page |
| `stepfun-ai/step-3.7-flash` | text-only | text + image, documented as a VLM | [NIM VLM example](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/step-3.7-flash/api.html) |
| `mistralai/mistral-medium-3.5-128b` | text-only | text + image, NIM-certified VLM | [VLM introduction](https://docs.nvidia.com/nim/vision-language-models/latest/introduction.html) |

A false positive here is **silent**. The model can read the image itself, but the
proxy intercepts it and sends a different model's *text description* instead.
Nothing errors; cost and latency rise and answer quality drops, and no test
fails. That is strictly worse than the bug #956 reports, which at least
announces itself.

The false entries are not the author's invention: **issue #956's own body lists
`minimaxai/minimax-m3` and `moonshotai/kimi-k2.6` as text-only.** Reporter and
PR author shared the same wrong premise and review passed it through. This is the
fourth time in this session's line of work that a hand-written allowlist over an
open string domain has been wrong; the pattern is the finding, not the individual
entries.

One caveat carried forward: the Mistral Medium 3.5 evidence describes the
**self-hosted** VLM NIM container, and that documentation explicitly warns not to
assume a general text endpoint exposes vision. We attach to hosted
`integrate.api.nvidia.com`. Re-verify against the hosted model page before the id
lands. Either way it is not confidently text-only, so #964's classification of it
is unsupported.

## Why not classify by name, tag, or API

Three candidate mechanisms, all rejected on evidence:

1. **A modality field from the API.** `GET /v1/models` on
   `integrate.api.nvidia.com` returns no input-modality field, and the documented
   VLM `/v1/models` schema carries identifiers, ownership, context length and
   permissions — no modalities. The registry really is the only source of truth,
   as #956 states.
2. **A naming convention.** `google/gemma-4-31b-it` carries no `vision`, `-vl`,
   or `omni` marker and [accepts text + image, processing video as frame
   sequences](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it).
   Counterexamples run both ways: `-vl` also appears on embedding and reranking
   models that are not chat generators at all.
3. **The catalog's own labels.** The `image-to-text` filter returns 7 entries
   while per-page verification finds 15 image-capable chat models. The labels are
   incomplete.

## The design: keep the short list, derive the long one

Maintain `NVIDIA_NIM_VISION_MODELS` — the models that CAN see — and compute
`noVisionModels` as the complement over the ids we actually classify.

This inverts the failure mode, which is the whole point. NIM adds models
continuously, so any hand-maintained list is stale on merge day. The question is
what happens to an id nobody has classified yet:

| Design | Unknown new model defaults to | Failure when wrong |
|---|---|---|
| #964: enumerate text-only | not in list → **no sidecar** | issue #956 persists — images blocked or 400 |
| ours: enumerate vision-capable | not in list → **sidecar on** | one extra description hop; image still works |

The second failure is recoverable and visible in logs. The first is the bug we
are fixing. The maintained list also shrinks from ~60 entries to 15, and the
short list is the one with authoritative per-model documentation behind it.

This mirrors `CLINE_PASS_TEXT_ONLY_MODELS`
(`src/providers/registry.ts:627`), which already derives text-only membership as
`CLINE_PASS_MODELS.filter(id => !CLINE_PASS_IMAGE_MODELS.has(id))`. The pattern
is established in this file; #964 simply did not follow it.

### Scope boundary

The complement is taken over **chat-capable** NIM ids only. Embeddings,
rerankers, guard/safety classifiers, OCR and document extraction, image and video
generation, speech, and simulation endpoints are not chat models and must not
appear in either list.

## Verified vision-capable set (2026-08-04)

High confidence, per-model NVIDIA documentation:

```
meta/llama-3.2-11b-vision-instruct
meta/llama-3.2-90b-vision-instruct
nvidia/llama-3.1-nemotron-nano-vl-8b-v1
nvidia/nemotron-nano-12b-v2-vl
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
nvidia/cosmos3-nano-reasoner
nvidia/ising-calibration-1.5-31b
nvidia/ising-calibration-1-35b-a3b
google/gemma-4-31b-it
google/diffusiongemma-26b-a4b-it
minimaxai/minimax-m3
moonshotai/kimi-k2.6
stepfun-ai/step-3.7-flash
thinkingmachines/inkling
mistralai/mistral-medium-3.5-128b
```

Flagged, not yet committed to code:

- `mistralai/mistral-medium-3.5-128b` — hosted-endpoint recheck pending (above);
  NVIDIA also showed a 2026-08-07 deprecation date.
- `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` — catalog indicated imminent
  deprecation; harmless if it disappears (an absent id classifies nothing).
- `google/paligemma` — established VLM, but its detail page 404s. Excluded from
  the vision list would make it text-only, which is wrong; excluded from
  classification entirely is correct until availability is confirmed.
- `nvidia/vila`, `microsoft/phi-3_5-vision-instruct`, DePlot, Phi-4 Multimodal —
  image-capable but hosted endpoint deprecated. `nvidia/neva-22b`,
  `kosmos-2`, `fuyu-8b` — no current hosted page found. #964's test asserts these
  historical ids stay out of `noVisionModels`; that assertion stays true under
  our design for free, since they are simply not classified.

## Planned diff

1. `src/providers/registry.ts`
   - add `NVIDIA_NIM_VISION_MODELS` (the verified set above) with a comment
     recording the verification date, the per-model source, and the standing
     instruction to append to THIS list, never to a text-only one;
   - add `NVIDIA_NIM_CHAT_MODELS` — the chat ids we classify, seeded from the
     live catalog snapshot and the existing `NVIDIA_NIM_KIMI_MODELS`;
   - derive `NVIDIA_NIM_NO_VISION_MODELS` as the filtered complement;
   - set `noVisionModels` on the `nvidia` entry and extend the entry comment.
2. No change to `src/vision/index.ts`, `src/codex/catalog/provider-fetch.ts`, or
   `src/router.ts`. The sidecar, the catalog's image-modality advertisement, and
   the registry→config merge all already do the right thing once the field is
   populated — which is why #956 has a working config-only workaround.

## Tests and the red-green plan

Extend `tests/nvidia-nim-hardening.test.ts` (the file #964 also chose):

1. **Vision-capable ids are absent from `noVisionModels`.** Seed with the five
   ids #964 got wrong. Ablate by adding one to the vision list's complement and
   watch it go red. This test is the direct regression guard for #964's defect.
2. **Representative text-only ids are present** — `deepseek-ai/deepseek-v4-flash`,
   `z-ai/glm-5.2`, `nvidia/nemotron-3-ultra-550b-a55b`, `openai/gpt-oss-120b`.
3. **The lists cannot overlap.** A structural assertion that
   `NVIDIA_NIM_VISION_MODELS ∩ noVisionModels = ∅`. Ablate by planting a
   duplicate id.
4. **Sidecar activation end to end** — `planVisionSidecar` returns a plan for a
   text-only NIM model carrying an image, `undefined` without an image, and
   `undefined` for `meta/llama-3.2-11b-vision-instruct` even with an image.
   (#964's equivalent test passes for the wrong reason on ids like kimi-k2.6; ours
   asserts the corrected classification.)
5. **A bare persisted nvidia config inherits the field** from the registry via
   `routeModel` — covers the #956 reporter's exact config shape.
6. **The catalog advertises image input** for a text-only NIM model and does not
   fabricate it for a vision-capable one.

Every guard gets driven red by ablation before it counts, per the unit's
verification discipline.
