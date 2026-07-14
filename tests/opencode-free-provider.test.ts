import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveFeaturedProviderIds } from "../src/providers/derive";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalRequest(model = "kimi-k2.7-code"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: {},
  };
}

describe("opencode-free provider", () => {
  const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-free");

  test("registry entry exists with correct shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("openai-chat");
    expect(entry?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(entry?.authKind).toBe("key");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.liveModels).toBe(true);
  });

  test("static headers include only the public client marker", () => {
    expect(entry?.staticHeaders?.["Authorization"]).toBeUndefined();
    expect(entry?.staticHeaders?.["x-opencode-client"]).toBe("desktop");
  });

  test("providerConfigSeed propagates static headers", () => {
    const seed = providerConfigSeed(entry!);
    expect(seed.headers?.["Authorization"]).toBeUndefined();
    expect(seed.headers?.["x-opencode-client"]).toBe("desktop");
    expect(seed.keyOptional).toBe(true);
    expect(seed.liveModels).toBe(true);
  });

  test("is included in the key-login map (keyOptional = true)", () => {
    const keyMap = deriveKeyLoginMap();
    expect(keyMap["opencode-free"]).toBeDefined();
  });

  test("is in the featured provider list", () => {
    expect(deriveFeaturedProviderIds()).toContain("opencode-free");
  });

  test("adapter sends no auth header with no apiKey configured", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(req.url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("user-supplied apiKey is sent when configured", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      apiKey: "user-secret-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-secret-key");
    expect(headers["x-opencode-client"]).toBe("desktop");
  });

  test("the provider client marker still applies when a user apiKey is present", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      apiKey: "user-secret-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-secret-key");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(Object.keys(headers)).toContain("Authorization");
  });

  test("provider note mentions no key needed", () => {
    expect(entry?.note?.toLowerCase()).toContain("no key needed");
    expect(entry?.note?.toLowerCase()).not.toContain("bearer public");
  });

  test("DeepSeek Free preserves reasoning content for tool-call history", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const request = adapterRequest("deepseek-v4-flash-free");
    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(request).body as string) as {
      messages: Array<Record<string, unknown> & { reasoning_content?: string }>;
    };
    expect(body.messages.find(message => message.role === "assistant")?.reasoning_content)
      .toBe("previous reasoning");
  });

  test("deriveProviderPresets exposes keyOptional for GUI picker", () => {
    const { deriveProviderPresets } = require("../src/providers/derive");
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "opencode-free");
    expect(preset).toBeDefined();
    expect(preset.keyOptional).toBe(true);
    expect(preset.note).toBeDefined();
  });
});

function adapterRequest(modelId: string) {
  return {
    modelId,
    stream: false,
    context: {
      messages: [
        { role: "user" as const, content: "inspect the repo", timestamp: 0 },
        {
          role: "assistant" as const,
          timestamp: 1,
          content: [
            { type: "thinking" as const, thinking: "previous reasoning" },
            { type: "toolCall" as const, id: "call_1", name: "read_file", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "call_1",
          toolName: "read_file",
          content: "contents",
          isError: false,
          timestamp: 2,
        },
      ],
    },
    options: { reasoning: "high" as const },
  };
}
