import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(): OcxParsedRequest {
  return {
    modelId: "claude-haiku-4-5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

describe("anthropic provider hardening", () => {
  test("key mode rejects a blank API key", () => {
    const adapter = createAnthropicAdapter(provider({ apiKey: "   " }));

    expect(() => adapter.buildRequest(parsed())).toThrow(
      "anthropic provider requires a non-empty apiKey (authMode: key)",
    );
  });

  test("OAuth mode rejects a blank injected token", () => {
    const adapter = createAnthropicAdapter(provider({ authMode: "oauth", apiKey: "" }));

    expect(() => adapter.buildRequest(parsed())).toThrow(
      "anthropic oauth token missing — run ocx login anthropic",
    );
  });

  test("rejects an unresolved Cloudflare AI Gateway placeholder", () => {
    const adapter = createAnthropicAdapter(provider({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic",
    }));

    expect(() => adapter.buildRequest(parsed())).toThrow(/unresolved \{account-id\}/);
  });

  test("rethrows a malformed baseUrl when prompt caching is enabled", () => {
    const baseUrl = "not a valid URL";
    const adapter = createAnthropicAdapter(provider({ baseUrl }), "short");

    expect(() => adapter.buildRequest(parsed())).toThrow(
      `anthropic provider has malformed baseUrl: ${baseUrl}`,
    );
  });

  test("publishes audited context windows for current Anthropic aliases", () => {
    const anthropic = PROVIDER_REGISTRY.find(entry => entry.id === "anthropic");

    expect(anthropic?.modelContextWindows?.["claude-opus-4-8"]).toBe(1_000_000);
    expect(anthropic?.modelContextWindows?.["claude-haiku-4-5"]).toBe(200_000);
  });
});
