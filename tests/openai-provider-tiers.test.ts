import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config";
import { deriveInitProviders, deriveProviderPresets, listRegistryEntries } from "../src/providers/derive";
import {
  builtInCodexAccountMode,
  isCanonicalOpenAiForwardProvider,
  LEGACY_CHATGPT_PROVIDER_ID,
  OPENAI_API_PROVIDER_ID,
  OPENAI_DIRECT_PROVIDER_ID,
  OPENAI_MULTI_PROVIDER_ID,
} from "../src/providers/openai-tiers";
import { OPENAI_PROVIDER_TIER_VERSION } from "../src/types";

describe("OpenAI provider tier foundation", () => {
  test("locks exact ids, modes, and migration version", () => {
    expect(OPENAI_DIRECT_PROVIDER_ID).toBe("openai");
    expect(OPENAI_MULTI_PROVIDER_ID).toBe("openai-multi");
    expect(OPENAI_API_PROVIDER_ID).toBe("openai-apikey");
    expect(LEGACY_CHATGPT_PROVIDER_ID).toBe("chatgpt");
    expect(OPENAI_PROVIDER_TIER_VERSION).toBe(1);
    expect(builtInCodexAccountMode("openai")).toBe("direct");
    expect(builtInCodexAccountMode("openai-multi")).toBe("pool");
    expect(builtInCodexAccountMode("openai-apikey")).toBeUndefined();
    expect(builtInCodexAccountMode("chatgpt")).toBeUndefined();
  });

  test("accepts only the canonical Codex forward transport", () => {
    const canonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward" as const,
    };
    expect(isCanonicalOpenAiForwardProvider(canonical)).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: `${canonical.baseUrl}/` })).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, adapter: "openai-chat" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, authMode: "key" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: `${canonical.baseUrl}/extra` })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: `${canonical.baseUrl}?x=1` })).toBe(false);
  });

  test("does not activate Multi in registry, presets, init, or fresh config", () => {
    expect(listRegistryEntries().some(entry => entry.id === OPENAI_MULTI_PROVIDER_ID)).toBe(false);
    expect(deriveProviderPresets().some(entry => entry.id === OPENAI_MULTI_PROVIDER_ID)).toBe(false);
    expect(deriveInitProviders().some(entry => entry.id === OPENAI_MULTI_PROVIDER_ID)).toBe(false);
    expect(Object.hasOwn(getDefaultConfig().providers, OPENAI_MULTI_PROVIDER_ID)).toBe(false);
  });
});
