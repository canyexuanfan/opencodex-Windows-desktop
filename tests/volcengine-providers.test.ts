import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveProviderPresets, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";

describe("Volcengine Ark providers", () => {
  test("publishes separate pay-as-you-go, Coding Plan, and Agent Plan contracts", () => {
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine")).toMatchObject({
      label: "Volcengine Ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      adapter: "openai-chat",
      authKind: "key",
      defaultModel: "doubao-seed-2-0-lite-260215",
      models: ["doubao-seed-2-0-lite-260215"],
      liveModels: true,
      thinkingToggleModels: ["doubao-seed-2-0-lite-260215"],
    });
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-coding-plan")).toMatchObject({
      label: "Volcengine Ark Coding Plan",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      adapter: "openai-chat",
      authKind: "key",
      defaultModel: "ark-code-latest",
      models: ["ark-code-latest"],
      liveModels: true,
    });
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-agent-plan")).toMatchObject({
      label: "Volcengine Ark Agent Plan",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      responsesPath: "/responses",
      adapter: "openai-responses",
      authKind: "key",
      liveModels: true,
    });
  });

  test("derives key login and dashboard presets from the canonical registry", () => {
    expect(KEY_LOGIN_PROVIDERS.volcengine).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-seed-2-0-lite-260215",
      liveModels: true,
    });
    expect(KEY_LOGIN_PROVIDERS["volcengine-coding-plan"]).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      defaultModel: "ark-code-latest",
      liveModels: true,
    });
    expect(KEY_LOGIN_PROVIDERS["volcengine-agent-plan"]).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      responsesPath: "/responses",
      adapter: "openai-responses",
      liveModels: true,
    });
    for (const id of ["volcengine", "volcengine-coding-plan", "volcengine-agent-plan"]) {
      expect(deriveProviderPresets().find(provider => provider.id === id)).toMatchObject({ auth: "key" });
    }
  });

  test("routes a minimal Agent Plan config to its native Responses resource", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "volcengine-agent-plan",
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-responses",
          baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
          authMode: "key",
          apiKey: "test-key",
        },
      },
    };
    const route = routeModel(config, "volcengine-agent-plan/ark-agent-latest");
    expect(route.provider.responsesPath).toBe("/responses");

    const request = createResponsesPassthroughAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: route.modelId, input: "ping", stream: true },
    }, { headers: new Headers() });
    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });

  test("maps the documented Ark thinking toggle on the pay-as-you-go Chat wire", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "volcengine",
      providers: {
        volcengine: {
          adapter: "openai-chat",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          authMode: "key",
          apiKey: "test-key",
        },
      },
    };
    const route = routeModel(config, "volcengine/doubao-seed-2-0-lite-260215");
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
      },
      stream: true,
      options: { reasoning: "high" },
    });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("keeps registry response paths in provider seeds and GUI display metadata", () => {
    const agentPlan = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-agent-plan")!;
    expect(providerConfigSeed(agentPlan).responsesPath).toBe("/responses");
    expect(formatProviderDisplayName("volcengine")).toBe("Volcengine Ark");
    expect(formatProviderDisplayName("volcengine-coding-plan")).toBe("Volcengine Ark Coding Plan");
    expect(formatProviderDisplayName("volcengine-agent-plan")).toBe("Volcengine Ark Agent Plan");
    expect(isCatalogProviderId("volcengine")).toBe(true);
    expect(isCatalogProviderId("volcengine-coding-plan")).toBe(true);
    expect(isCatalogProviderId("volcengine-agent-plan")).toBe(true);
  });
});
