# 000 — Seeding `glm-5.3-flash` ahead of the providers that will serve it

## The ask, and why the codebase already agrees with it

Put `glm-5.3-flash` everywhere `ox-alpha` or `glm-5.2` already lives, before the
providers announce it.

That is not a new policy. `src/providers/registry.ts:340-342` states it:

> The non-Z.AI providers below are speculative on purpose: they carry 5.2 today and are
> expected to pick 5.3 up on their usual lag. Providers whose live `/v1/models`
> discovery is enabled self-correct on the next successful fetch; static ones need a
> follow-up refresh.

This unit is the same move one generation on. Two facts make it safe:

- `rg glm-5.3-flash` returns **nothing** today, so there is no duplicate id to collide with.
- `glm-4.7-flash` already sits beside `glm-4.7` in `ZHIPU_BIGMODEL_TEXT_MODELS`, so a
  flash sibling next to its full model is an established shape here, not an invention.

## What `glm-5.3-flash` is

Z.AI's flash tier for GLM-5.3: 1M context, text-only, cheaper than the full model. Where
a provider needs a number this unit does not have from that provider's own docs, it
**mirrors the `glm-5.3` entry that provider already carries** rather than inventing a
figure. That is stated per-cluster below and is the difference between seeding and guessing.

## The vision decision, made once

`glm-5.3-flash` goes into **no** vision list, and it is added to `noVisionModels`
wherever `glm-5.2` appears there.

`registry.ts:500-506` records why:

> Verified-negative and therefore deliberately ABSENT: … zai-org/GLM-5.2, zai-org/GLM-5.3
> … Those routes accept the request and drop the image, which is worse than declining it
> — the model answers about an image it never saw.

A flash variant inherits that suspicion until someone proves otherwise. Same reasoning
excludes it from `COMMAND_CODE_IMAGE_MODELS`.

## The `ox-alpha` surfaces: excluded, with a reason

`ox-alpha` appears in three places — `COMMAND_CODE_IMAGE_MODELS` (registry.ts:508-509),
`command-code-efforts.ts:15`, and two `modelContextWindows` blocks (1203, 1523, 1941).

**All three are vision/Command-Code surfaces, and `glm-5.3-flash` gets none of them.**
`COMMAND_CODE_IMAGE_MODELS` is the image allowlist the paragraph above forbids. The
context-window blocks exist to describe Ox Alpha's 1.05M multimodal window on Command
Code, a provider whose catalog does not carry `glm-5.2` at all — seeding a Z.AI flash
model into a Command Code table would advertise a model that provider never serves.

So the honest reading of "ox-alpha가 있는곳" is: reviewed, and deliberately empty. The
`glm-5.2` surfaces are where this model actually belongs.

## Insertion points

Every one of these already carries `glm-5.2`; `glm-5.3-flash` goes in beside `glm-5.3`.

| # | Location | Symbol | Note |
|---|---|---|---|
| 1 | registry.ts:474 | `ZHIPU_BIGMODEL_TEXT_MODELS` | flash sibling precedent lives here (`glm-4.7-flash`) |
| 2 | registry.ts:480 | `ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS` | 5.3 is present, so the toggle applies |
| 3 | registry.ts:616 + 627 | `ALIBABA_TOKEN_PLAN_MODELS` + input modalities | `["text"]`, matching its `glm-5.3` |
| 4 | registry.ts:639 | `ALIBABA_INTL_TOKEN_PLAN_MODELS` | + modalities at 854-ish block |
| 5 | registry.ts:689 / 697 / 715 | Volcengine coding / agent / text-only | text-only list too |
| 6 | registry.ts:864 | `NEURALWATT_REASONING_HISTORY_MODELS` | Neuralwatt suffixes its ids; see caution below |
| 7 | registry.ts:944 | baseten list | |
| 8 | registry.ts:952 | `SCALEWAY_SERVERLESS_CHAT_MODELS` | |
| 9 | registry.ts:973 / 982 / 988 | `UMANS_MODELS` + text-only + context | prefix is `umans-` |
| 10 | registry.ts:997 / 1012 | cline-pass | prefix is `cline-pass/` |
| 11 | registry.ts:2201 / 2282 / 2284 | `zai` + `zhipu-bigmodel-coding` provider blocks | context window mirrors 5.3's 1M |
| 12 | registry.ts:2428 / 2464 | alibaba plan context windows | 1M, mirroring 5.3 |
| 13 | registry.ts:2514 / 2517 | ollama-cloud | |
| 14 | registry.ts:2730 | cloudflare `@cf/zai-org/…` | prefix form |

**Caution on 6 and 11.** Neuralwatt fans each model into `-fast` / `-short` /
`-short-fast` variants and the parity test pins the full list with `toEqual`. Z.AI fans
into `[1m]` aliases with three pinned `toEqual` maps. Adding a bare id to either without
its variants leaves the tables internally inconsistent. This unit adds the **plain
`glm-5.3-flash`** id and does not synthesize `-fast`/`-short`/`[1m]` variants: those
suffixes encode routing behavior those providers documented per model, and inventing
them would assert a product that may not exist.

## The test surface — this is the real work

`tests/provider-registry-parity.test.ts` pins exact lists with `toEqual` (17 `glm-5.3`
hits). Every seeded list has a matching assertion that must move in the same commit, or
the suite goes red. Also covering these tables: `volcengine-providers`,
`cline-pass-provider`, `alibaba-intl-token-plan`, `catalog-vision-sidecar-modalities`,
`codex-catalog`, `umans-provider`, `routing-compatibility-model-matching`.

`src/generated/model-metadata.ts` is **generated** (`scripts/generate-model-metadata.ts`,
"Do not edit by hand") and is NOT touched here. Its data comes from upstream catalogs; it
will pick `glm-5.3-flash` up on the next regeneration once providers publish it.

## Accept criteria

## Where a seed actually reaches the user (measured)

Seeding only matters where the static catalog is what ships. Reading each provider block:

| Provider | liveModels | modelDiscovery | Seed reaches the user? |
|---|---|---|---|
| `zhipu-bigmodel` | false | no | **yes** — static |
| `alibaba-token-plan` / `-intl` | false | no | **yes** — static |
| `volcengine-coding-plan` / `-agent-plan` | false | no | **yes** — static |
| `neuralwatt` | false | no | **yes** — static |
| `umans` | false | no | **yes** — static |
| `zai` | false | no | **yes** — static |
| `ollama-cloud` | false | no | **yes** — static |
| `zhipu-bigmodel-coding` | true | no | seed is the offline fallback |
| `cline-pass` | true | no | seed is the offline fallback |
| `baseten` | true | yes | overwritten on first successful fetch |
| `scaleway` | true | yes | overwritten on first successful fetch |
| `cloudflare-workers-ai` | true | yes | overwritten on first successful fetch |

This confirms the claim quoted at the top of this document rather than assuming it: the
static providers are exactly the ones that "need a follow-up refresh", and they are the
majority here. The three discovery-enabled providers still get the id — it is their
documented offline fallback, and a wrong-but-harmless entry there is replaced the moment
a real fetch succeeds.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every `glm-5.2` provider list also carries `glm-5.3-flash` | `rg` shows the pair per cluster |
| 2 | No vision/image list gains it | it appears in `noVisionModels`, never `modelInputModalities` as image |
| 3 | ox-alpha surfaces reviewed and excluded on the record | this document |
| 4 | Parity and provider tests green | narrow `bun test` on the 7 covering files |
| 5 | Types hold | `bun x tsc --noEmit` |
| 6 | Landed | CI green, PR merged, local `dev` level |

## Loop spec

- Archetype: spec-satisfaction repair; the verifier is the parity suite plus `rg`.
- Write scope: `src/providers/registry.ts`, the covering tests, this devlog unit. One
  branch, one PR. No `main`, no force-push to `dev`.
- Escalation: if a provider's list turns out to be live-discovery-only such that seeding
  is meaningless, exclude it and record that here rather than padding the diff.
