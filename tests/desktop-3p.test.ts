import { describe, expect, spyOn, test } from "bun:test";
import {
  buildDesktop3pRegistry,
  deriveDesktop3pCode,
  generateDesktop3pConfig,
  generateDesktop3pModels,
  resolveDesktop3pAlias,
} from "../src/claude/desktop-3p";

describe("Claude Desktop 3P models", () => {
  test("derives stable golden codes", () => {
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toBe("ncb");
    expect(deriveDesktop3pCode("opencode-go/glm-5.2")).toBe("yrf");
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toMatch(/^[a-z][0-9a-z]{2}$/);
  });

  test("generates labeled opus-tier entries and one family default", () => {
    expect(generateDesktop3pModels(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    )).toEqual([
      {
        name: "claude-opus-4-ncb",
        labelOverride: "GPT 5.6 Sol (native)",
        anthropicFamilyTier: "opus",
        isFamilyDefault: true,
      },
      {
        name: "claude-opus-4-yrf",
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

  test("resolves aliases from the current registry", () => {
    const registry = buildDesktop3pRegistry(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    );
    expect(registry.get("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-yrf")).toBe("opencode-go/glm-5.2");
    expect(resolveDesktop3pAlias("claude-opus-4-unknown")).toBeNull();
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
      expect(resolveDesktop3pAlias("claude-opus-4-vdu")).toBe("test/model-123");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).toContain("skipping test/model-155");
    } finally {
      warning.mockRestore();
    }
  });

  test("generates a valid static gateway config", () => {
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
      modelDiscoveryEnabled: false,
    });
    expect(reparsed.inferenceModels.map((model: { name: string }) => model.name)).toEqual([
      "claude-opus-4-ncb",
      "claude-opus-4-6",
    ]);
  });
});
