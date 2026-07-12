import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildModelsRequest } from "../src/oauth";
import {
  resolveProviderTransport,
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../src/providers/xai-transport";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(authMode: "oauth" | "key"): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode,
    apiKey: authMode === "oauth" ? "oauth-token" : "xai-api-key",
    defaultModel: "grok-4.5",
  };
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "grok-4.5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "low" },
  };
}

describe("xAI auth-mode transport selection", () => {
  test("OAuth selects the Grok CLI subscription transport and required headers", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"));
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe(XAI_GROK_CLI_BASE_URL);
    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/chat/completions`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("OAuth model discovery uses the subscription transport", () => {
    const request = buildModelsRequest(provider("oauth"), "oauth-token", "xai");

    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/models`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("API key keeps the xAI API transport without subscription headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured);
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
    const modelsRequest = buildModelsRequest(configured, "xai-api-key", "xai");

    expect(effective).toBe(configured);
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(modelsRequest.url).toBe("https://api.x.ai/v1/models");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer xai-api-key",
    });
    expect(modelsRequest.headers).toEqual({ Authorization: "Bearer xai-api-key" });
  });

  test("custom providers and configured header overrides remain untouched", () => {
    const custom = provider("oauth");
    custom.headers = { "x-grok-client-version": "0.2.94", "x-custom": "kept" };

    expect(resolveProviderTransport("custom-xai", custom)).toBe(custom);
    expect(resolveProviderTransport("xai", custom).headers).toMatchObject({
      "x-grok-client-version": "0.2.94",
      "x-custom": "kept",
      "x-grok-client-identifier": "opencodex",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });
});
