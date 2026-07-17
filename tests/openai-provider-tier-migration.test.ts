import { describe, expect, test } from "bun:test";
import {
  OpenAiTierMigrationCollisionError,
  OPENAI_DIRECT_PROVIDER_ID,
  OPENAI_MULTI_PROVIDER_ID,
  projectOpenAiTierMigration,
} from "../src/providers/openai-tiers";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const canonicalForward: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: { openai: { ...canonicalForward } },
    defaultProvider: "openai",
    ...overrides,
  };
}

describe("OpenAI tier migration projection", () => {
  test("projects a fresh config without activating Multi", () => {
    const input = config();
    const before = structuredClone(input);
    const result = projectOpenAiTierMigration(input);

    expect(result.changed).toBe(true);
    expect(result.legacyPoolIntent).toBe(false);
    expect(result.config.openaiProviderTierVersion).toBe(1);
    expect(Object.keys(result.config.providers)).toEqual([OPENAI_DIRECT_PROVIDER_ID]);
    expect(result.config.providers.openai).toEqual(canonicalForward);
    expect(result.config.defaultProvider).toBe(OPENAI_DIRECT_PROVIDER_ID);
    expect(input).toEqual(before);
    expect(result.config).not.toBe(input);
  });

  test("includes Multi after Direct for added-account pool intent and moves the legacy default", () => {
    const input = config({
      providers: {
        customA: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "keep-a" },
        openai: { ...canonicalForward, apiKey: "discard-reserved-secret" },
        customB: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "keep-b" },
      },
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false }],
      defaultProvider: "openai",
    });
    const before = structuredClone(input);
    const result = projectOpenAiTierMigration(input);

    expect(result.legacyPoolIntent).toBe(true);
    expect(Object.keys(result.config.providers)).toEqual(["customA", "openai", "openai-multi", "customB"]);
    expect(result.config.providers.openai).toEqual(canonicalForward);
    expect(result.config.providers[OPENAI_MULTI_PROVIDER_ID]).toEqual(canonicalForward);
    expect(result.config.providers.customA.apiKey).toBe("keep-a");
    expect(result.config.providers.customB.apiKey).toBe("keep-b");
    expect(JSON.stringify(result.config)).not.toContain("discard-reserved-secret");
    expect(result.config.defaultProvider).toBe(OPENAI_MULTI_PROVIDER_ID);
    expect(input).toEqual(before);
  });

  test("treats an explicitly set main account id as pool intent", () => {
    const result = projectOpenAiTierMigration(config({ activeCodexAccountId: "main" }));
    expect(result.legacyPoolIntent).toBe(true);
    expect(result.config.defaultProvider).toBe(OPENAI_MULTI_PROVIDER_ID);
    expect(result.config.providers[OPENAI_MULTI_PROVIDER_ID]).toEqual(canonicalForward);
  });

  for (const [label, chatgpt] of [
    ["canonical", { ...canonicalForward }],
    ["key/custom-base", { adapter: "openai-responses", baseUrl: "https://legacy.example/v1", authMode: "key", apiKey: "legacy-key" }],
    ["extra-field", { ...canonicalForward, headers: { "x-legacy-secret": "legacy-token" } }],
  ] as const) {
    for (const poolIntent of [false, true]) {
      test(`removes any ${label} chatgpt row with poolIntent=${poolIntent}`, () => {
        const oauthStore = { chatgpt: { access: "oauth-store-access", refresh: "oauth-store-refresh" } };
        const oauthBefore = structuredClone(oauthStore);
        const input = config({
          providers: {
            before: { adapter: "openai-chat", baseUrl: "https://before.example/v1" },
            chatgpt: chatgpt as OcxProviderConfig,
            after: { adapter: "openai-chat", baseUrl: "https://after.example/v1" },
          },
          defaultProvider: "chatgpt",
          ...(poolIntent
            ? { codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false }] }
            : {}),
        });
        const serializedInput = JSON.stringify(input);
        const result = projectOpenAiTierMigration(input);
        const second = projectOpenAiTierMigration(result.config);

        expect(Object.hasOwn(result.config.providers, "chatgpt")).toBe(false);
        expect(Object.keys(result.config.providers)).toEqual(poolIntent
          ? ["before", "after", "openai", "openai-multi"]
          : ["before", "after", "openai"]);
        expect(result.config.defaultProvider).toBe(poolIntent ? OPENAI_MULTI_PROVIDER_ID : OPENAI_DIRECT_PROVIDER_ID);
        expect(JSON.stringify(result.config)).not.toContain("legacy-key");
        expect(JSON.stringify(result.config)).not.toContain("legacy-token");
        expect(JSON.stringify(input)).toBe(serializedInput);
        expect(oauthStore).toEqual(oauthBefore);
        expect(second.changed).toBe(false);
        expect(second.config).toEqual(result.config);
      });
    }
  }

  test("preserves an explicitly configured canonical Multi row without inferred pool intent", () => {
    const result = projectOpenAiTierMigration(config({
      providers: {
        openai: { ...canonicalForward },
        "openai-multi": { ...canonicalForward },
        custom: { adapter: "openai-chat", baseUrl: "https://custom.example/v1" },
      },
      defaultProvider: "openai-multi",
    }));
    expect(result.legacyPoolIntent).toBe(false);
    expect(Object.keys(result.config.providers)).toEqual(["openai", "openai-multi", "custom"]);
    expect(result.config.providers[OPENAI_MULTI_PROVIDER_ID]).toEqual(canonicalForward);
    expect(result.config.defaultProvider).toBe(OPENAI_MULTI_PROVIDER_ID);
  });

  for (const [label, collision] of [
    ["key/custom-base", { adapter: "openai-responses", baseUrl: "https://custom.example/v1", authMode: "key", apiKey: "multi-secret" }],
    ["extra-field", { ...canonicalForward, headers: { "x-multi-secret": "multi-secret" } }],
  ] as const) {
    test(`fails closed on a ${label} preexisting Multi collision`, () => {
      const input = config({
        providers: { openai: { ...canonicalForward }, "openai-multi": collision as OcxProviderConfig },
      });
      const serializedInput = JSON.stringify(input);
      expect(() => projectOpenAiTierMigration(input)).toThrow(OpenAiTierMigrationCollisionError);
      expect(JSON.stringify(input)).toBe(serializedInput);
      expect(JSON.stringify(input)).toContain("multi-secret");
    });
  }

  test("preserves a custom default and nonlegacy provider order", () => {
    const result = projectOpenAiTierMigration(config({
      providers: {
        first: { adapter: "openai-chat", baseUrl: "https://first.example/v1" },
        openai: { ...canonicalForward },
        last: { adapter: "openai-chat", baseUrl: "https://last.example/v1" },
      },
      defaultProvider: "last",
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false }],
    }));
    expect(result.config.defaultProvider).toBe("last");
    expect(Object.keys(result.config.providers)).toEqual(["first", "openai", "openai-multi", "last"]);
  });

  test("marker 1 is clone-only idempotent and never resurrects removed Multi", () => {
    const input = config({ openaiProviderTierVersion: 1 });
    const before = structuredClone(input);
    const result = projectOpenAiTierMigration(input);

    expect(result.changed).toBe(false);
    expect(result.config).toEqual(before);
    expect(result.config).not.toBe(input);
    expect(Object.hasOwn(result.config.providers, OPENAI_MULTI_PROVIDER_ID)).toBe(false);
    expect(input).toEqual(before);
  });

  test("a second projection is marker-idempotent", () => {
    const first = projectOpenAiTierMigration(config({
      activeCodexAccountId: "pool-a",
      providers: { chatgpt: { adapter: "openai-chat", baseUrl: "https://legacy.example", apiKey: "discard-me" } },
      defaultProvider: "chatgpt",
    }));
    const second = projectOpenAiTierMigration(first.config);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(JSON.stringify(second.config)).not.toContain("discard-me");
  });
});
