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

### `src/config.ts` — no change (decision, audit finding 4)

`responsesPath` carries explicit validation (`providerResponsesPathConfigError`,
`config.ts:486-493`) because a malformed path silently breaks routing. A boolean has
no malformed form, and `providerConfigSchema` is `.passthrough()`, so
`statelessResponses` needs no schema line. Recording the decision rather than leaving
it implicit.

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
  const drop = ["previous_response_id", "conversation", "background", "metadata"] as const;
  const present = drop.some(k => Object.prototype.hasOwnProperty.call(body, k));
  if (!present && body.store === false) return body;
  const next: Record<string, unknown> = { ...body };
  for (const key of drop) delete next[key];
  next.store = false;
  return next;
}
```

### `service_tier` is deliberately NOT dropped (audit blocker 3)

DSCodex drops it, and the DeepSeek request schema does not list it. But `core.ts:758`
writes `service_tier` for EVERY `openai-responses` route when `config.fastMode` is
set. Silently deleting a configured knob inside an adapter — with no diagnostic — is
worse than forwarding a parameter the upstream ignores: the research doc records that
DeepSeek ignores unrecognised tool types and input items rather than erroring, and
nothing in the reference page says an unknown top-level key is fatal.

Dropping it would also make the adapter quietly override a server-level decision,
which is the kind of action-at-a-distance that is hard to debug later. If DeepSeek
turns out to reject it, that is a one-line addition to `drop` with real evidence
behind it. Leaving it in is the reversible choice.

Wire it in `buildRequest` immediately after the existing `stripPreviousResponseId`
call, before the forward-only branch:

```ts
       let outBody = stripPreviousResponseId(...);
+      if (provider.statelessResponses === true) outBody = stripStatefulResponsesParams(outBody);
```

Placing it here means `stripItemIdsWhenUnstored` (which keys off `store === false`)
then runs with the correct premise — a small consistency win beyond the primary fix.

## Accept criteria

- Built body for a stateless provider contains none of the four dropped keys and
  carries `store: false`.
- A non-stateless Responses provider is byte-identical to before.
- `service_tier` SURVIVES the strip (regression guard for the decision above).
- A registry entry that does not declare the field does not acquire it from the seed
  (negative control mirroring `tests/provider-model-discovery-contract.test.ts:175`),
  so a future blanket seed cannot leak the capability provider-wide.

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The branch is triggered by building a request against the deepseek config with a body
that deliberately carries `previous_response_id` and `metadata`; the observable effect
is their absence from `JSON.parse(built.body)` plus `store === false`. The negative
control builds the same body against a provider without the flag and asserts the keys
survive, proving the strip is capability-gated rather than unconditional.
