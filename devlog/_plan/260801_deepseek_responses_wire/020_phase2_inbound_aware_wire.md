# 020 — Phase 2: scope the registry wire default to the inbound protocol

## Problem

`providerModelWireDefault()` knows the provider and model but not which inbound
surface is asking, so `{ "deepseek-v4-flash": "openai-responses" }` fires for all
three callers of `resolveWireProtocolOverride()`:

- `src/server/responses/core.ts` (+ `fetch-helpers`, `collaboration`, `compact`,
  `encrypted-payload`) — Responses inbound.
- `src/server/claude-messages.ts` — Anthropic Messages inbound.
- `src/server/chat-completions.ts` — Chat Completions inbound.

Claude Code and Chat clients therefore pay a translation hop onto a wire they never
requested, when DeepSeek serves their native wire directly.

## Design

Represent the default as inbound-scoped rather than unconditional. Keep the existing
string form working (it means "any inbound") so no other registry entry changes
meaning, and add an object form carrying the inbound scope.

```ts
/** Which inbound protocol a registry wire default applies to. */
export type InboundWire = "responses" | "chat" | "anthropic";

export type ModelWireDefault = string | { wire: string; inbound: readonly InboundWire[] };
```

`resolveWireProtocolOverride` gains a trailing optional `inbound` parameter. It is
optional so the many call sites that are already Responses-inbound do not all need
editing in one commit; the default is `"responses"`, which is the surface the
existing behaviour was designed for and the majority of call sites.

> Deviation note: an earlier sketch made the parameter required. That would touch 10
> call sites in `responses/core.ts` alone for no behavioural gain and would make the
> diff hard to audit. Defaulting to `"responses"` keeps the risky edit surface at the
> two non-Responses callers, which are exactly the ones whose behaviour changes.

## Change map

### MODIFY `src/providers/registry.ts`

```ts
+export type InboundWire = "responses" | "chat" | "anthropic";
+export type ModelWireDefault = string | { wire: string; inbound: readonly InboundWire[] };

-  modelWireDefaults?: Record<string, string>;
+  modelWireDefaults?: Record<string, ModelWireDefault>;
```

`providerModelWireDefault` takes the inbound and honours the scope:

```ts
 export function providerModelWireDefault(
   id: string,
   provider: ...,
   modelId: string,
   allowedWires: ReadonlySet<string>,
+  inbound: InboundWire,
 ): string | undefined {
   ...
   const entry = getProviderRegistryEntry(id);
   if (!entry?.modelWireDefaults || !providerMatchesRegistryTransport(id, provider)) return undefined;
-  const wire = entry.modelWireDefaults[modelId.trim().toLowerCase()];
+  const declared = entry.modelWireDefaults[modelId.trim().toLowerCase()];
+  if (declared === undefined) return undefined;
+  const wire = typeof declared === "string" ? declared : declared.wire;
+  if (typeof declared !== "string" && !declared.inbound.includes(inbound)) return undefined;
   return wire !== undefined && allowedWires.has(wire) ? wire : undefined;
 }
```

DeepSeek's entry becomes scoped:

```ts
-    modelWireDefaults: { "deepseek-v4-flash": "openai-responses" },
+    modelWireDefaults: {
+      // Codex speaks Responses natively and DeepSeek ships a Codex-compatible
+      // apply_patch tool on that wire, so a Responses inbound goes straight out with
+      // zero translation. Claude Code (Anthropic) and OpenAI-compatible clients keep
+      // the provider-wide Chat wire: DeepSeek serves Chat Completions natively too,
+      // so translating them into Responses would add a hop onto our newest upstream
+      // path for no gain.
+      "deepseek-v4-flash": { wire: "openai-responses", inbound: ["responses"] },
+    },
```

### MODIFY `src/server/adapter-resolve.ts`

```ts
 export function resolveWireProtocolOverride(
   providerName: string,
   modelId: string,
   providerConfig: OcxProviderConfig,
+  inbound: InboundWire = "responses",
 ): OcxProviderConfig {
   ...
-    : providerModelWireDefault(providerName, providerConfig, modelId, MODEL_ADAPTER_OVERRIDE_ALLOWED);
+    : providerModelWireDefault(providerName, providerConfig, modelId, MODEL_ADAPTER_OVERRIDE_ALLOWED, inbound);
```

An explicitly configured `modelAdapters` override still wins — user intent outranks a
registry default on every inbound.

### MODIFY `src/server/claude-messages.ts` (~line 599)

```ts
-    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
+    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "anthropic");
```

### MODIFY `src/server/chat-completions.ts` (~line 81)

```ts
-    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
+    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "chat");
```

Responses call sites are left alone; the default covers them.

## Accept criteria

- Resolver returns `openai-responses` for inbound `responses`, `openai-chat` for
  inbound `anthropic` and `chat`.
- A string-form `modelWireDefaults` entry still applies on every inbound.
- An explicit `modelAdapters` override still wins on a non-Responses inbound.

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The new guard `!declared.inbound.includes(inbound)` is triggered by calling the
resolver with `"anthropic"`/`"chat"` against the deepseek config; the observable
effect is the returned config keeping `adapter: "openai-chat"` instead of flipping.
The positive control is the same call with `"responses"` still flipping to
`openai-responses`, proving the guard is scope-selective rather than always-off.
