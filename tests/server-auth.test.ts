import { afterEach, describe, expect, test } from "bun:test";
import {
  assertServerAuthConfig,
  corsHeaders,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  safeConfigDTO,
} from "../src/server";
import type { OcxConfig } from "../src/types";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;

function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { Authorization: "Bearer provider-secret", "X-Custom": "secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
});

describe("server local API auth", () => {
  test("loopback hostnames do not require opencodex API auth", () => {
    expect(isLoopbackHostname(undefined)).toBe(true);
    expect(isLoopbackHostname("")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isApiAuthRequired(config())).toBe(false);
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
  });

  test("non-loopback binding requires env token before startup", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).toThrow("OPENCODEX_API_AUTH_TOKEN");

    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).not.toThrow();
  });

  test("auth header must match env token when non-loopback auth is required", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    const cfg = config("0.0.0.0");

    expect(hasValidApiAuth(new Request("http://localhost/api/config"), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "wrong" },
    }), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "local-secret" },
    }), cfg)).toBe(true);
  });

  test("loopback remains allowed even when env token exists", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(hasValidApiAuth(new Request("http://localhost/api/config"), config("127.0.0.1"))).toBe(true);
  });

  test("CORS preflight permits the opencodex API key header", () => {
    expect(corsHeaders()["Access-Control-Allow-Headers"]).toContain("X-OpenCodex-API-Key");
  });

  test("safeConfigDTO redacts provider secrets and exposes booleans", () => {
    const dto = safeConfigDTO(config("127.0.0.1")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(JSON.stringify(dto)).not.toContain("sk-secret-value");
    expect(JSON.stringify(dto)).not.toContain("provider-secret");
    expect(dto.providers.openai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      hasApiKey: true,
      hasHeaders: true,
    });
    expect(dto.providers.openai).not.toHaveProperty("apiKey");
    expect(dto.providers.openai).not.toHaveProperty("headers");
  });
});
