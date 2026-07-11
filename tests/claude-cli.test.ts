import { describe, expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/cli/claude";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

describe("ocx claude env assembly", () => {
  test("injects base URL, discovery flag and model slots — NO auth token by default (subscription mode)", () => {
    const env = buildClaudeEnv(cfg({
      claudeCode: { model: "claude-ocx-gemini--gemini-3-pro", smallFastModel: "gemini/gemini-3-flash" },
    }), 10123, {});
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10123");
    // Setting ANTHROPIC_AUTH_TOKEN disables claude.ai connectors and kills subscription
    // OAuth — the launcher must leave it unset on an open loopback proxy.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ANTHROPIC_MODEL).toBe("claude-ocx-gemini--gemini-3-pro");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gemini/gemini-3-flash");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("gemini/gemini-3-flash");
    // Never both token vars (Claude Code auth-conflict warning, 003 E1).
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // First-party bypass keeps connectors/Design/Files API alive through proxy.
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });

  test("configured API key becomes the auth token (admission required)", () => {
    const env = buildClaudeEnv(cfg({
      apiKeys: [{ id: "1", name: "main", key: "sk-ocx-123", createdAt: "2026-01-01" }],
    }), 10100, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ocx-123");
  });

  test("user-exported env always wins; unset slots stay unset", () => {
    const env = buildClaudeEnv(cfg(), 10100, {
      ANTHROPIC_BASE_URL: "http://my-own-gateway:9",
      ANTHROPIC_MODEL: "my-model",
      PATH: "/usr/bin",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://my-own-gateway:9");
    expect(env.ANTHROPIC_MODEL).toBe("my-model");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
  });

  test("user can override the first-party bypass", () => {
    const env = buildClaudeEnv(cfg(), 10100, {
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "0",
    });
    // User-exported env always wins.
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("0");
  });
});
