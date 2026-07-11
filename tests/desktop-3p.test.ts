import { describe, expect, spyOn, test } from "bun:test";
import {
  buildDesktop3pRegistry,
  deriveDesktop3pCode,
  desktop3pAlias,
  generateDesktop3pConfig,
  generateDesktop3pModels,
  legacyDesktop3pAlias,
  resolveDesktop3pAlias,
} from "../src/claude/desktop-3p";
import { resolveInboundModel } from "../src/claude/inbound";

describe("Claude Desktop 3P models", () => {
  test("derives stable golden codes", () => {
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toBe("ncb");
    expect(deriveDesktop3pCode("opencode-go/glm-5.2")).toBe("yrf");
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toMatch(/^[a-z][0-9a-z]{2}$/);
  });

  test("aliases use the opus-4-8 prefix and never collide with real dateless ids", () => {
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-8-ncb");
    expect(legacyDesktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-ncb");
    // Real Anthropic ids pass through untouched (dateless canonical form).
    expect(desktop3pAlias("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    // Letter-first suffix: can never equal a bare real id or a numeric date suffix.
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
  });

  test("generates labeled opus-tier entries and one family default", () => {
    expect(generateDesktop3pModels(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    )).toEqual([
      {
        name: "claude-opus-4-8-ncb",
        labelOverride: "GPT 5.6 Sol (native)",
        anthropicFamilyTier: "opus",
        isFamilyDefault: true,
      },
      {
        name: "claude-opus-4-8-yrf",
        labelOverride: "GLM 5.2 (opencode-go)",
        anthropicFamilyTier: "opus",
      },
    ]);
  });

  test("passes Anthropic Claude model ids through without encoding", () => {
    const models = generateDesktop3pModels([], [
      { provider: "anthropic", id: "claude-opus-4-6" },
    ]);
    expect(models[0]?.name).toBe("claude-opus-4-6");
    expect(models[0]?.anthropicFamilyTier).toBe("opus");
  });

  test("keeps real Anthropic ids OUT of the decode registry (native passthrough survives)", () => {
    buildDesktop3pRegistry([], [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-fable-5" },
    ]);
    expect(resolveDesktop3pAlias("claude-opus-4-8")).toBeNull();
    expect(resolveDesktop3pAlias("claude-fable-5")).toBeNull();
    // resolveInboundModel stays identity → wantsNativePassthrough keeps firing.
    expect(resolveInboundModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveInboundModel("claude-fable-5")).toBe("claude-fable-5");
  });

  test("resolves aliases from the current registry", () => {
    const registry = buildDesktop3pRegistry(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    );
    expect(registry.get("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-8-yrf")).toBe("opencode-go/glm-5.2");
    // Legacy pre-rename aliases still decode (stale Desktop configs).
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-yrf")).toBe("opencode-go/glm-5.2");
    expect(resolveDesktop3pAlias("claude-opus-4-8-unknown")).toBeNull();
  });

  test("warns and skips the second route on an alias collision", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = generateDesktop3pModels([], [
        { provider: "test", id: "model-123" },
        { provider: "test", id: "model-155" },
      ]);
      expect(deriveDesktop3pCode("test/model-123")).toBe("vdu");
      expect(deriveDesktop3pCode("test/model-155")).toBe("vdu");
      expect(models).toHaveLength(1);
      expect(resolveDesktop3pAlias("claude-opus-4-8-vdu")).toBe("test/model-123");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).toContain("skipping test/model-155");
    } finally {
      warning.mockRestore();
    }
  });

  test("generates a discovery-mode config by default", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }],
      "test-key",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: true,
    });
    expect(reparsed.inferenceModels).toBeUndefined();
    // Discovery mode still refreshes the decode registry.
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("generates a valid static gateway config with --static", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }],
      "test-key",
      "static",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: false,
    });
    expect(reparsed.inferenceModels.map((model: { name: string }) => model.name)).toEqual([
      "claude-opus-4-8-ncb",
      "claude-opus-4-6",
    ]);
    // Static generation also refreshes the decode registry (new + legacy aliases).
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
  });
});
