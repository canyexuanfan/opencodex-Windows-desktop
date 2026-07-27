# 030 — Regression coverage

Work phase: `wp4-tests` · Criteria: `c4-tests`, `c5-typecheck`

Two files change: the parity list gets the new id, and a new focused test file
carries the behavioral assertions. The parity append alone is what the reviewers
rejected (B5), so it never stands on its own here.

## `tests/provider-registry-parity.test.ts`

```diff
-  "huggingface", "nvidia", "venice", "zai", "nanogpt", "synthetic", ...
+  "huggingface", "nvidia", "venice", "zai", "zhipu-bigmodel", "nanogpt", "synthetic", ...
```

Position matters: `EXPECTED_KEY_PROVIDER_IDS` is compared with `toEqual` against
`Object.keys(KEY_LOGIN_PROVIDERS)`, so the array order must match registry
order, and `020` places the entry directly after `zai`.

## New file: `tests/zhipu-bigmodel-provider.test.ts`

Modeled on `tests/tencent-siliconflow-providers.test.ts` — same imports, same
shape, so it reads as part of the existing family.

### Test 1 — the provider contract

```ts
const entry = PROVIDER_REGISTRY.find(provider => provider.id === "zhipu-bigmodel");
expect(entry).toMatchObject({
  label: "Zhipu AI — BigModel",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  adapter: "openai-chat",
  authKind: "key",
  defaultModel: "glm-4.6",
  jawcodeBundle: "zai",
});
expect(entry?.modelContextWindows?.["glm-4.6"]).toBe(204_800);
expect(entry?.modelInputModalities?.["glm-4.6v"]).toEqual(["text", "image"]);
expect(entry?.noVisionModels).toContain("glm-4.6");
expect(entry?.noVisionModels).not.toContain("glm-4.6v");
expect(entry?.liveModels).toBeUndefined();
```

### Test 2 — the id cannot hijack a saved credential

This is the regression guard for B1, and it is the assertion that would have
failed on the original PR head:

```ts
const directoryIds = new Set(FREE_PROVIDER_DIRECTORY.map(row => row.id));
expect(directoryIds.has("zhipu-bigmodel")).toBe(false);
// the ids this provider must never claim, because they already resolve elsewhere
expect(entry?.id).not.toBe("glm");
expect(entry?.id).not.toBe("glm-cn");
```

Plus the routing proof that a saved `glm` config is still untouched by the new
entry:

```ts
const route = routeModel(configWithSavedGlmProvider, "glm/glm-4.6");
expect(route.provider.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
```

`glm` is not in `PROVIDER_REGISTRY`, so `routedProviderConfig()` returns the
saved config unchanged — asserting it here pins the behavior the collision would
have broken.

### Test 3 — request shaping emits the thinking toggle

The behavioral assertion AGENTS.md asks for. Route through the real adapter and
read the built body:

```ts
const route = routeModel(config, "zhipu-bigmodel/glm-4.6");
const adapter = resolveAdapter(route.provider.adapter);
const built = adapter.buildRequest({ ...parsedRequest, options: { reasoning: "high" } }, route.provider);
expect(built.body.thinking).toEqual({ type: "enabled" });
expect(built.body.reasoning_effort).toBeUndefined();
```

And the disabled half, since a one-sided toggle test passes even if the map is
stuck:

```ts
// reasoning: "low" maps to disabled through THINKING_TOGGLE_MAP
expect(builtLow.body.thinking).toEqual({ type: "disabled" });
expect(builtLow.body.reasoning_effort).toBeUndefined();
```

The exact `buildRequest` signature is read from
`src/adapters/openai-chat.ts` and an existing adapter test before writing this —
the sketch above is the intent, not a promise about the parameter shape.

### Test 4 — derived surfaces

```ts
expect(KEY_LOGIN_PROVIDERS["zhipu-bigmodel"]).toMatchObject({
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  defaultModel: "glm-4.6",
});
expect(deriveProviderPresets().find(p => p.id === "zhipu-bigmodel")).toMatchObject({ auth: "key" });
expect(deriveJawcodeAliases()["zhipu-bigmodel"]).toBe("zai");
```

## Verification

```bash
bun test tests/zhipu-bigmodel-provider.test.ts
bun test tests/provider-registry-parity.test.ts
bun run typecheck
```

Then the full `bun run test` once, with any pre-existing failures recorded as
baseline rather than attributed to this change.
