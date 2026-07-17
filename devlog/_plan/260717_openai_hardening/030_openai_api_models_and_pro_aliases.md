# Cycle 030 — OpenAI API Metadata and Pro Virtual Models

## Objective

Add official GPT-5.6 API metadata and exactly three API-only virtual Pro choices.
Keep virtual identity on all OCX/user surfaces; translate only API wire requests.

## Trusted metadata owners

### MODIFY `src/types.ts`

Add `modelMaxInputTokens?: Record<string, number>` to `OcxProviderConfig` with
positive-integer schema validation. Do not add virtual model maps to persisted config.

### MODIFY `src/providers/registry.ts`

Add registry-only:

```ts
virtualModels?: Record<string, { wireModelId: string; reasoningMode: "pro" }>;
modelMaxInputTokens?: Record<string, number>;
```

For `openai-apikey`, set models `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and the three
Pro ids. Base/alias/Pro rows use 1,050,000 context, 922,000 max input, text+image,
and Codex-supported `low,medium,high,xhigh,max`. Define no generic `gpt-5.6-pro`.
Keep OpenRouter constants untouched.

### MODIFY `src/providers/derive.ts`

Clone `modelMaxInputTokens` into config hints. Do not clone registry-only virtual maps
into user/provider config or management DTOs.

### NEW `src/providers/openai-virtual-models.ts`

Export exact pure functions:

```ts
resolveOpenAiVirtualModel(providerName, selectedModelId)
applyOpenAiVirtualModel(parsed, route, logCtx)
resolveOpenAiCompactModel(providerName, selectedModelId)
```

They read trusted registry metadata only, require provider `openai-apikey` and exact
keys, reject namespaced/blank wire ids, and never infer from a `-pro` suffix.

Normal Responses behavior:

- preserve original namespaced selection in `logCtx.requestedModel`;
- set `logCtx.model` to selected local id such as `gpt-5.6-sol-pro`;
- rewrite `route.modelId`, `parsed.modelId`, and raw body model to base id;
- merge `reasoning.mode="pro"`, overriding a conflicting mode while preserving
  independent supported effort and other allowed reasoning fields.

Compact behavior is fixed by the official schema: map virtual id to base id and send
no `reasoning` member because `ResponseCompactParams` has no reasoning field.
Compaction does not change the selected model stored by Codex; the next `/responses`
turn reapplies Pro mode.

## Catalog and request flow

### MODIFY `src/codex/catalog.ts`

- Extend `CatalogModel` with `maxInputTokens`.
- Provider hints read `modelMaxInputTokens`.
- Routed `auto_compact_token_limit` becomes
  `min(floor(effectiveContextWindow*0.9), maxInputTokens)`; a 350K user cap stays 315K.
- Add `augmentRoutedModelsWithRegistryVirtuals` after live/static gathering and before
  visibility/sort. It clones base metadata, applies provider hints, and replaces a
  same-id live row with the trusted virtual row while warning once per collision.
- Direct/Multi rows never receive API virtuals or API context values.

### MODIFY `src/router.ts`

Merge registry `modelMaxInputTokens` under user numeric hints. Virtual mapping is not
placed on the route provider; the resolver receives provider name explicitly.

### MODIFY `src/server/responses.ts`

Immediately after `routeModel` and namespace stripping, call
`applyOpenAiVirtualModel` before effort caps/native clamps. Native clamp continues to
use original namespaced `requestedModel`, so routed Pro never masquerades as native.
Change the compact signature to:

```ts
export async function handleResponsesCompact(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response>;
```

It calls `resolveOpenAiCompactModel`, emits the base id only, and sets
`logCtx.model` to the selected local virtual id, `logCtx.requestedModel` to the
original namespaced id, `logCtx.resolvedModel` to the base id, and
`logCtx.provider` to `route.providerName`.

### MODIFY `src/server/index.ts`

For `POST /responses/compact`, allocate request id/start time and a
`RequestLogContext` before calling `handleResponsesCompact(req, config, logCtx)`.
Finalize the request log on success and failure with the same response-status/error
rules as `/responses`. Compact usage may remain `unreported`, but the persisted entry
must preserve the three model identities.

### MODIFY `src/server/request-log.ts` and `src/usage/log.ts`

Add `requestedModel?: string` to `PersistedUsageEntry`, its JSON normalizer, and the
`addRequestLog` persistence payload. Then use the fields with fixed ownership:

- `model` = selected local id (virtual id for Pro);
- `requestedModel` = original caller id including provider namespace;
- `resolvedModel` = upstream response/base model.

`addRequestLog` persists selected `model`, namespaced `requestedModel`, and optional
base `resolvedModel` unchanged. No separate wire-id field is added.

### MODIFY `src/usage/summary.ts`

Retain grouping by provider + persisted selected `model`; never group by
`resolvedModel`. Add a regression proving three Pro rows do not collapse into bases.

## Tests and activation proof

### MODIFY `tests/provider-registry-parity.test.ts`

Assert exact seven GPT-5.6 API ids (alias, three bases, three Pro), official metadata,
three mappings, no generic alias, and no virtual map in derived management config.

### MODIFY `tests/codex-catalog.test.ts`

Assert API rows/virtual clones, 922K uncapped compaction, 315K at 350K provider cap,
collision replacement/warning, and Direct/Multi metadata isolation.

### NEW `tests/openai-api-virtual-models.test.ts`

Capture HTTP and WS outbound requests for all three Pro ids. Assert API URL/key,
base wire model, mode Pro, preserved effort, selected log model, namespaced requested
model, base resolved model, and zero Codex account headers. Base models, other
providers, unknown `-pro`, and forged config maps remain unchanged/rejected.

Capture compact requests for standard and all Pro ids. Assert API key + base model and
absence of `reasoning`; Direct/Multi compact behavior remains Cycle-020-owned. Query
`/api/logs` and inspect the temporary usage JSONL to assert virtual `model`, namespaced
`requestedModel`, base `resolvedModel`, routed provider (never `unknown`), and compact
usage status `unreported`.

### MODIFY `tests/request-log.test.ts`, `tests/usage-log.test.ts`, and
`tests/usage-summary.test.ts`

After HTTP, WS, and compact Pro requests, query `/api/logs` and reread usage JSONL.
Assert selected virtual `model`, namespaced `requestedModel`, base `resolvedModel`,
and routed provider; summaries group by virtual id.

## Verification and exit gate

```sh
bun test tests/provider-registry-parity.test.ts tests/codex-catalog.test.ts tests/openai-api-virtual-models.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts
bun x tsc --noEmit
```

Accept only when every advertised virtual id has captured HTTP/WS/compact wire proof
and no provider/config/body outside the exact API mappings is transformed.
