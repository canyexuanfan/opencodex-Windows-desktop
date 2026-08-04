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

## The design: change the predicate, not the list

**A first version of this document proposed maintaining the 15 vision-capable ids
and deriving text-only as their complement. The A-gate audit falsified it and I
reproduced the failure** (`001_audit_response.md`, B1). A complement taken over a
static `NVIDIA_NIM_CHAT_MODELS` still leaves an unclassified id in *neither*
list:

```console
$ bun run .tmp/probe_complement.ts     # the proposed shape, modelled exactly
deepseek-ai/deepseek-v4-flash            sidecarWouldRun=true
moonshotai/kimi-k2.6                     sidecarWouldRun=false
brandnew/model-nobody-classified         sidecarWouldRun=false   <-- #956 persists
```

I had inverted which list is maintained while keeping the closed world. Any
design expressed purely as *list contents* inherits closed-world semantics,
because the classification is membership-in-a-list. Escaping it requires changing
the **predicate**.

### Two fields, one default

1. **`NVIDIA_NIM_VISION_MODELS`** — the 15 verified natively-image-capable ids.
   These are the exception, and they carry per-model NVIDIA documentation.
2. **A provider-level default** — for the `nvidia` entry, a model that is *not*
   in the vision list is treated as needing the sidecar, without enumerating it.

Concretely this means the `nvidia` entry declares its text-only membership as
"everything except the vision list" rather than as a snapshot of ids. The
registry already carries per-provider capability flags
(`ProviderRegistryEntry`, `src/providers/registry.ts:190-230`); this adds one
more whose semantics are *default-on with an exception list*, and `router.ts`
merges it beside `noVisionModels` (`src/router.ts:243`) so a user's explicit
config still wins.

Now the open-domain case lands correctly:

| Design | Unclassified new NIM model | Failure when wrong |
|---|---|---|
| #964: enumerate text-only | no sidecar | **#956 persists** — images blocked or 400 |
| complement over a static set | no sidecar | **#956 persists** (falsified above) |
| default-on with an exception list | sidecar runs | one extra description hop; image still works |

Only the third actually closes the issue for models NVIDIA has not shipped yet.

### Why the exception list is safe to hand-maintain

The objection that killed the previous design does not apply here. A stale
*exception* list degrades gracefully: a newly-released vision model missing from
it gets an unnecessary description hop, which is slower and costs a call but
still answers. A stale *enumeration* silently reproduces the reported bug. The
asymmetry is the entire argument, and it only holds when the default is on.

### Scope boundary

Default-on applies to **chat** ids only. Embeddings, rerankers, guard/safety
classifiers, OCR and document extraction, image/video generation, speech, and
simulation endpoints never reach `planVisionSidecar` in the first place — they
are not routed as chat models — but the implementation must confirm that rather
than assume it, since a default-on rule has a wider blast radius than a list.

### Verified vision models also need explicit modalities (audit B2)

Keeping a native-vision id out of `noVisionModels` is necessary but **not
sufficient**. `applyProviderConfigHints` adds `image` to a model's
`inputModalities` only for `noVisionModels` members
(`src/codex/catalog/provider-fetch.ts:176-184`), and NIM `/v1/models` publishes
no modality metadata. So a model left out of both would be advertised text-only
and the Codex app would block attachments client-side — the model can see, and
the user still cannot send.

Every id in `NVIDIA_NIM_VISION_MODELS` therefore also gets
`modelInputModalities[id] = ["text", "image"]`, following the shape
`ZHIPU_BIGMODEL_INPUT_MODALITIES` already uses
(`src/providers/registry.ts:327-331`). The test asserts the **emitted catalog
payload** carries `image`, not merely that the id is absent from a list.

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
   - add `modelInputModalities` entries pinning `["text","image"]` for each of
     those ids (audit B2);
   - declare the provider-level default-on rule on the `nvidia` entry, with the
     vision list as its exception set, and extend the entry comment to explain
     why NIM specifically gets a default rather than an enumeration.
2. The predicate change touches the classification path, so the surfaces that
   read `noVisionModels` must each be checked rather than assumed:
   `planVisionSidecar` (`src/vision/index.ts:235`), the fail-closed strip in
   `src/server/responses/core.ts:1581`, the catalog hint
   (`src/codex/catalog/provider-fetch.ts:176`), the registry→config merge
   (`src/router.ts:243`), the seed fill (`src/providers/derive.ts:257`), and
   `src/cli/models.ts:44`. A user's explicit config `noVisionModels` must keep
   winning over the default.
3. No behavioral change is intended for any other provider. The default is
   scoped to the `nvidia` entry; every other entry keeps enumerating.

## Tests and the red-green plan

Extend `tests/nvidia-nim-hardening.test.ts` (the file #964 also chose):

1. **An unclassified id gets the sidecar.** The regression guard for audit B1:
   a NIM model id that appears in no list at all must still produce a vision
   plan when the request carries an image. Ablate by reverting to an enumerated
   `noVisionModels` and watch it go red. This is the test the first design could
   not have passed.
2. **Vision-capable ids do NOT get the sidecar.** Seed with the five ids #964 got
   wrong — `thinkingmachines/inkling`, `minimaxai/minimax-m3`,
   `moonshotai/kimi-k2.6`, `stepfun-ai/step-3.7-flash`,
   `mistralai/mistral-medium-3.5-128b` — plus the two llama-3.2 vision ids.
   `planVisionSidecar` returns `undefined` for each even with an image attached.
3. **The catalog advertises image input for both classes, for different
   reasons** (audit B2): a text-only id gets `image` via the `noVisionModels`
   hint, and a verified vision id gets it via `modelInputModalities`. Assert the
   emitted payload in both cases. Ablate the `modelInputModalities` entries and
   watch the vision-id case go red.
4. **Representative text-only ids still classify correctly** —
   `deepseek-ai/deepseek-v4-flash`, `z-ai/glm-5.2`,
   `nvidia/nemotron-3-ultra-550b-a55b`, `openai/gpt-oss-120b`. Sidecar on, no
   image forwarded raw.
5. **A user's explicit config wins.** A persisted `nvidia` provider that names
   its own `noVisionModels` is not overridden by the provider default.
6. **A bare persisted nvidia config gets the fix** through `routeModel` — the
   #956 reporter's exact config shape, which today needs a manual workaround.
7. **No other provider changes classification.** A structural assertion over
   `PROVIDER_REGISTRY` that the default-on rule is scoped to `nvidia` only.

Every guard gets driven red by ablation before it counts, per the unit's
verification discipline.
