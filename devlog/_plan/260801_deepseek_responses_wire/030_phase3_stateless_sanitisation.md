# 030 — Phase 3: stop sending stateful parameters to a stateless Responses upstream

## Problem

`stripPreviousResponseId(body, strip)` strips only when the proxy expanded the input
or when `authMode === "forward"`. Its docstring justifies keeping the field otherwise:

> API-key mode keeps the field on unexpanded requests: the platform `/v1/responses`
> supports real server-side storage.

True for the OpenAI platform, false for DeepSeek, which documents: *"The API is
stateless: responses and conversations are not stored on the server."* On a replay
expansion miss (proxy restart, unrecorded prior turn) we would forward
`previous_response_id` to an upstream that does not implement it.

The same reasoning covers the rest of the stateful family: `conversation`,
`background`, and `store: true`. `metadata` and `service_tier` are likewise absent
from the documented request schema.

## Design

Add a registry-declared capability rather than a provider-id check in the adapter, so
the knowledge lives where the other provider facts live and any future stateless
Responses provider inherits it.

```ts
  /**
   * Responses upstream that stores nothing server-side. Stateful request
   * parameters are dropped and `store` is pinned false.
   */
  statelessResponses?: boolean;
```

## Change map

### MODIFY `src/providers/registry.ts`

Add `statelessResponses?: boolean` to `ProviderRegistryEntry`, and on `deepseek`:

```ts
+    // "The API is stateless: responses and conversations are not stored on the
+    // server." https://api-docs.deepseek.com/api/create-response/
+    statelessResponses: true,
```

### MODIFY `src/types.ts`

Add the matching optional field to `OcxProviderConfig` beside `responsesPath`.

### MODIFY `src/providers/derive.ts`

Seed + backfill exactly as phase 1 does for `responsesPath`.

### MODIFY `src/adapters/openai-responses.ts`

New helper, placed next to `stripPreviousResponseId`:

```ts
/**
 * Drop request parameters a stateless Responses upstream does not implement, and pin
 * `store` false so item-id scrubbing downstream behaves consistently.
 *
 * `previous_response_id` is handled separately because its normal strip is
 * conditional on replay expansion; here the field can never be honoured at all.
 */
function stripStatefulResponsesParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const drop = ["previous_response_id", "conversation", "background", "metadata", "service_tier"] as const;
  const present = drop.some(k => Object.prototype.hasOwnProperty.call(body, k));
  if (!present && body.store === false) return body;
  const next: Record<string, unknown> = { ...body };
  for (const key of drop) delete next[key];
  next.store = false;
  return next;
}
```

Wire it in `buildRequest` immediately after the existing `stripPreviousResponseId`
call, before the forward-only branch:

```ts
       let outBody = stripPreviousResponseId(...);
+      if (provider.statelessResponses === true) outBody = stripStatefulResponsesParams(outBody);
```

Placing it here means `stripItemIdsWhenUnstored` (which keys off `store === false`)
then runs with the correct premise — a small consistency win beyond the primary fix.

## Accept criteria

- Built body for a stateless provider contains none of the five dropped keys and
  carries `store: false`.
- A non-stateless Responses provider is byte-identical to before.

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The branch is triggered by building a request against the deepseek config with a body
that deliberately carries `previous_response_id` and `metadata`; the observable effect
is their absence from `JSON.parse(built.body)` plus `store === false`. The negative
control builds the same body against a provider without the flag and asserts the keys
survive, proving the strip is capability-gated rather than unconditional.
