import { describe, expect, test } from "bun:test";
import { buildProviderPayload } from "../gui/src/provider-payload";

describe("provider dashboard payload", () => {
  test("persists explicit API-key mode for built-in OAuth providers", () => {
    expect(buildProviderPayload({
      adapter: " openai-chat ",
      baseUrl: " https://api.x.ai/v1 ",
      authMode: "key",
      apiKey: " xai-key ",
      defaultModel: " grok-4.5 ",
    })).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "xai-key",
      defaultModel: "grok-4.5",
    });
  });

  test("does not persist secrets for forward or local modes", () => {
    const base = {
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "must-not-leak",
      defaultModel: "",
    };
    expect(buildProviderPayload({ ...base, authMode: "forward" })).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
      authMode: "forward",
    });
    expect(buildProviderPayload({ ...base, authMode: "local" })).toEqual({
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
    });
  });
});
