import { describe, expect, test } from "bun:test";
import { resolveOpenAiVirtualModel, applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../src/providers/openai-virtual-models";

describe("OpenAI API virtual model resolution", () => {
  // 1. Each Pro virtual id resolves to base + reasoningMode "pro"
  for (const [virtual, base] of [
    ["gpt-5.6-sol-pro", "gpt-5.6-sol"],
    ["gpt-5.6-terra-pro", "gpt-5.6-terra"],
    ["gpt-5.6-luna-pro", "gpt-5.6-luna"],
  ] as const) {
    test(`${virtual} resolves to ${base} with mode pro on openai-apikey`, () => {
      const result = resolveOpenAiVirtualModel("openai-apikey", virtual);
      expect(result).toBeDefined();
      expect(result!.wireModelId).toBe(base);
      expect(result!.reasoningMode).toBe("pro");
      expect(result!.selectedModelId).toBe(virtual);
    });
  }

  // 2. Base models are NOT virtual
  for (const base of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    test(`base model ${base} is not virtual on openai-apikey`, () => {
      expect(resolveOpenAiVirtualModel("openai-apikey", base)).toBeUndefined();
    });
  }

  // 3. Non-API providers never resolve virtuals
  for (const provider of ["openai", "openai-multi", "anthropic", "cursor"]) {
    test(`${provider} never resolves virtual models`, () => {
      expect(resolveOpenAiVirtualModel(provider, "gpt-5.6-sol-pro")).toBeUndefined();
    });
  }

  // 4. Unknown -pro suffix is not virtual
  test("unknown model with -pro suffix is not virtual", () => {
    expect(resolveOpenAiVirtualModel("openai-apikey", "gpt-99-pro")).toBeUndefined();
  });
});

describe("applyOpenAiVirtualModel", () => {
  test("rewrites Pro request: model to base, merges reasoning.mode=pro, preserves effort", () => {
    const parsed = {
      modelId: "gpt-5.6-sol-pro",
      _rawBody: { model: "gpt-5.6-sol-pro", reasoning: { effort: "high" } },
      options: { reasoning: "high" },
    } as any;
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-sol-pro", provider: {} } as any;
    const logCtx = { model: "gpt-5.6-sol-pro", provider: "openai-apikey" } as any;
    applyOpenAiVirtualModel(parsed, route, logCtx);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed._rawBody.model).toBe("gpt-5.6-sol");
    expect(parsed._rawBody.reasoning).toEqual({ effort: "high", mode: "pro" });
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(logCtx.model).toBe("gpt-5.6-sol-pro");
    expect(logCtx.resolvedModel).toBe("gpt-5.6-sol");
  });

  test("non-virtual model is unchanged", () => {
    const parsed = { modelId: "gpt-5.6-sol", _rawBody: { model: "gpt-5.6-sol" }, options: {} } as any;
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-sol", provider: {} } as any;
    const logCtx = { model: "gpt-5.6-sol", provider: "openai-apikey" } as any;
    applyOpenAiVirtualModel(parsed, route, logCtx);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(route.modelId).toBe("gpt-5.6-sol");
  });
});

describe("resolveOpenAiCompactModel", () => {
  test("Pro virtual returns base wire model", () => {
    const result = resolveOpenAiCompactModel("openai-apikey", "gpt-5.6-sol-pro");
    expect(result.wireModelId).toBe("gpt-5.6-sol");
    expect(result.isVirtual).toBe(true);
  });

  test("base model returns itself", () => {
    const result = resolveOpenAiCompactModel("openai-apikey", "gpt-5.6-sol");
    expect(result.wireModelId).toBe("gpt-5.6-sol");
    expect(result.isVirtual).toBe(false);
  });
});
