import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { AnthropicTokenError, refreshAnthropicToken } from "../src/oauth/anthropic";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

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
  test("AnthropicTokenError carries parsed status and OAuth error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    try {
      await refreshAnthropicToken("secret");
      throw new Error("expected refresh failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicTokenError);
      expect(error).toMatchObject({ httpStatus: 400, oauthError: "invalid_grant" });
    }
  });

  test("AnthropicTokenError tolerates a malformed error body", async () => {
    globalThis.fetch = (async () => new Response("not-json", { status: 503 })) as typeof fetch;
    await expect(refreshAnthropicToken("secret")).rejects.toMatchObject({ httpStatus: 503, oauthError: undefined });
  });

  test("refresh with a non-finite expires_in falls back to a finite default expiry", async () => {
    globalThis.fetch = (async () => new Response(
      // JSON.stringify would turn Infinity into null; hand-write 1e999 so JSON.parse
      // yields Infinity, which would previously produce expires: NaN (never refreshing).
      '{"access_token":"at","refresh_token":"rt","expires_in":1e999}',
      { status: 200 },
    )) as typeof fetch;

    const cred = await refreshAnthropicToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(Date.now());
  });

  test("key mode rejects a blank API key", async () => {
    const adapter = createAnthropicAdapter(provider({ apiKey: "   " }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "anthropic provider requires a non-empty apiKey (authMode: key)",
    );
  });

  test("OAuth mode rejects a blank injected token", async () => {
    const adapter = createAnthropicAdapter(provider({ authMode: "oauth", apiKey: "" }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "anthropic oauth token missing — run ocx login anthropic",
    );
  });

  test("rejects an unresolved Cloudflare AI Gateway placeholder", async () => {
    const adapter = createAnthropicAdapter(provider({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic",
    }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(/unresolved \{account-id\}/);
  });

  test("rethrows a malformed baseUrl when prompt caching is enabled", async () => {
    const baseUrl = "not a valid URL";
    const adapter = createAnthropicAdapter(provider({ baseUrl }), "short");

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      `anthropic provider has malformed baseUrl: ${baseUrl}`,
    );
  });

  test("publishes audited context windows for current Anthropic aliases", async () => {
    const anthropic = PROVIDER_REGISTRY.find(entry => entry.id === "anthropic");

    expect(anthropic?.modelContextWindows?.["claude-opus-4-8"]).toBe(1_000_000);
    expect(anthropic?.modelContextWindows?.["claude-opus-5"]).toBe(1_000_000);
    expect(anthropic?.modelContextWindows?.["claude-haiku-4-5"]).toBe(200_000);
  });
});
