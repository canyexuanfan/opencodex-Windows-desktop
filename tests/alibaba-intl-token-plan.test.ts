import { describe, expect, test } from "bun:test";
import {
  baseUrlForChoice,
  matchChoiceId,
  resolvedBaseUrlForChoice,
} from "../gui/src/base-url-choice";
import {
  ALIBABA_INTL_BASE_URL_CHOICES,
  ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
  ALIBABA_INTL_PAYG_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets } from "../src/providers/derive";

const CHOICES = [...ALIBABA_INTL_BASE_URL_CHOICES];

describe("alibaba-token-plan-intl registry entry", () => {
  test("registry entry exists with correct base URL and choices", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(entry!.allowBaseUrlOverride).toBe(true);
    expect(entry!.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    expect(entry!.baseUrlChoices).toEqual([...ALIBABA_INTL_BASE_URL_CHOICES]);
  });

  test("model list includes multi-vendor lineup", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.models).toContain("qwen3.7-max");
    expect(entry!.models).toContain("deepseek-v4-pro");
    expect(entry!.models).toContain("kimi-k2.7-code");
    expect(entry!.models).toContain("glm-5.2");
    expect(entry!.models).toContain("MiniMax-M2.5");
    expect(entry!.models!.length).toBe(10);
  });

  test("MiniMax case-insensitive normalization is set", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.metadataModelIdNormalize).toBe("case-insensitive");
  });

  test("non-reasoning models are marked", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan-intl");
    expect(entry!.noReasoningModels).toContain("kimi-k2.7-code");
    expect(entry!.noReasoningModels).toContain("deepseek-v3.2");
    expect(entry!.noReasoningModels).toContain("MiniMax-M2.5");
  });

  test("presets API projection includes baseUrlChoices", () => {
    const preset = deriveProviderPresets().find(p => p.id === "alibaba-token-plan-intl");
    expect(preset?.baseUrl).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(preset?.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    const payg = preset?.baseUrlChoices?.find(c => c.id === "payg");
    expect(payg?.baseUrl).toBe(ALIBABA_INTL_PAYG_BASE_URL);
  });
});

describe("alibaba-intl endpoint choice helpers", () => {
  test("matchBaseUrlChoice maps known hosts", () => {
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe("token-plan");
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_PAYG_BASE_URL + "/")).toBe("payg");
    expect(matchBaseUrlChoice(ALIBABA_INTL_BASE_URL_CHOICES, "https://example.com/v1")).toBe("custom");
  });

  test("gui choice helpers work with intl choices", () => {
    expect(baseUrlForChoice(CHOICES, "token-plan", "")).toBe(ALIBABA_INTL_TOKEN_PLAN_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "payg", ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe(ALIBABA_INTL_PAYG_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "custom", ALIBABA_INTL_TOKEN_PLAN_BASE_URL)).toBe("");
    expect(resolvedBaseUrlForChoice(CHOICES, "payg", "https://stale/v1")).toBe(ALIBABA_INTL_PAYG_BASE_URL);
    expect(matchChoiceId(CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL + "/")).toBe("token-plan");
  });
});
