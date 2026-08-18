import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ClientPathError,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  zcodeConfigPath,
  zcodeHomeDir,
  type ExportContext,
  type ZcodeGeneratedConfig,
} from "../src/clients/config-export";
import type { OcxConfig } from "../src/types";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function context(): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config: CONFIG,
    models: [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
      { namespaced: "xai/grok-5", provider: "xai", id: "grok-5", displayName: "Grok 5", contextWindow: 262_144 },
      // No authoritative context window: ships without limit rather than guessing.
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
      // Audio-only cannot be represented in ZCode's text/image vocabulary: dropped.
      { namespaced: "zenmux/audio-only", provider: "zenmux", id: "audio-only", inputModalities: ["audio"] },
    ],
  };
}

describe("ZCode client config", () => {
  test("adds only provider.opencodex in ZCode's observed v2 schema", () => {
    const document = buildClientConfig("zcode", context()) as ZcodeGeneratedConfig;
    expect(Object.keys(document)).toEqual(["provider"]);
    const provider = document.provider[OPENCODE_PROVIDER_ID]!;
    expect(provider.name).toBe("OpenCodex");
    expect(provider.kind).toBe("anthropic");
    expect(provider.enabled).toBe(true);
    expect(provider.source).toBe("custom");
    expect(provider.options).toEqual({
      apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
      baseURL: "http://127.0.0.1:10100",
      apiKeyRequired: true,
    });
  });

  test("models carry authoritative limits, text-floor modalities, and drop audio-only rows", () => {
    const document = buildClientConfig("zcode", context()) as ZcodeGeneratedConfig;
    const models = document.provider[OPENCODE_PROVIDER_ID]!.models;
    expect(Object.keys(models).sort()).toEqual(["anthropic/claude-opus-5", "mystery/model", "xai/grok-5"]);
    expect(models["anthropic/claude-opus-5"]).toEqual({
      name: "claude-opus-5 (anthropic)",
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 200_000, output: 32_000 },
    });
    // Undeclared modalities fall back to the text floor.
    expect(models["xai/grok-5"]!.modalities).toEqual({ input: ["text"], output: ["text"] });
    // No authoritative window: no limit field at all, never a guessed one.
    expect(models["mystery/model"]).not.toHaveProperty("limit");
  });

  test("native JSON round-trips and never carries a credential", () => {
    const sentinel = ["sk", "live", "zcode", "sentinel"].join("-");
    const withKey = { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const built = buildClientConfigText("zcode", { ...context(), config: withKey });
    expect(built.format).toBe("json");
    expect(JSON.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain(sentinel);
    expect(built.text).toContain(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("the contribution owns exactly the provider.opencodex path", () => {
    const contribution = buildClientContribution("zcode", context());
    expect(contribution.clientId).toBe("zcode");
    expect(contribution.fragments.map(f => f.path)).toEqual([["provider", OPENCODE_PROVIDER_ID]]);
  });

  test("resolves the data-dir override and the documented v2 destination", () => {
    expect(zcodeHomeDir({}, "/home/u")).toBe(join("/home/u", ".zcode"));
    expect(zcodeConfigPath({}, "/home/u")).toBe(join("/home/u", ".zcode", "v2", "config.json"));
    expect(zcodeConfigPath({ ZCODE_DATA_DIR: "/elsewhere" }, "/home/u")).toBe(join("/elsewhere", "v2", "config.json"));
    expect(() => zcodeConfigPath({ ZCODE_DATA_DIR: "relative" }, "/home/u")).toThrow(ClientPathError);
  });
});

