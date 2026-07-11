import { describe, expect, test } from "bun:test";
import { boundedContextWindows, buildClaudeContextWindows, effectiveModelEnv, withOneMillionMarker } from "../src/claude/context-windows";
import { desktop3pAlias } from "../src/claude/desktop-3p";

describe("claude context-window map (devlog 260712 B2)", () => {
  const routed = [
    { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 },
    { provider: "opencode-go", id: "glm-5.2", contextWindow: 1_000_000 },
    { provider: "mock", id: "small-model", contextWindow: 128_000 },
    { provider: "mock", id: "no-window" },
  ];

  test("registers all four selector forms for routed models", () => {
    const map = buildClaudeContextWindows([], routed);
    expect(map["cursor/gpt-5.6-luna"]).toBe(1_000_000);
    expect(map[desktop3pAlias("cursor", "gpt-5.6-luna")]).toBe(1_000_000);
    expect(map["claude-ocx-cursor--gpt-5.6-luna"]).toBe(1_000_000);
    expect(map["mock/small-model"]).toBe(128_000);
    expect(map["mock/no-window"]).toBeUndefined();
  });

  test("registers native slugs (bare + desktop alias + legacy alias)", () => {
    const map = buildClaudeContextWindows(["gpt-5.6-sol", "gpt-5.4"], []);
    // Authoritative native overrides: gpt-5.6 natives 372k, gpt-5.4 native 1M.
    expect(map["gpt-5.6-sol"]).toBe(372_000);
    expect(map[desktop3pAlias("native", "gpt-5.6-sol")]).toBe(372_000);
    expect(map["claude-ocx-native--gpt-5.6-sol"]).toBe(372_000);
    expect(map["gpt-5.4"]).toBe(1_000_000);
  });

  test("first-wins on alias collisions (registry policy)", () => {
    // test/model-123 and test/model-155 share the 3-char code (known golden collision).
    const map = buildClaudeContextWindows([], [
      { provider: "test", id: "model-123", contextWindow: 111 },
      { provider: "test", id: "model-155", contextWindow: 222 },
    ]);
    expect(map[desktop3pAlias("test", "model-123")]).toBe(111);
    // provider/id keys stay distinct even when the alias collides.
    expect(map["test/model-155"]).toBe(222);
  });

  test("withOneMillionMarker marks only >=1M, never double-suffixes, ignores unknown", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000, "mock/small-model": 128_000 };
    expect(withOneMillionMarker("cursor/gpt-5.6-luna", windows)).toBe("cursor/gpt-5.6-luna[1m]");
    expect(withOneMillionMarker("cursor/gpt-5.6-luna[1m]", windows)).toBe("cursor/gpt-5.6-luna[1m]");
    expect(withOneMillionMarker("mock/small-model", windows)).toBe("mock/small-model");
    expect(withOneMillionMarker("unknown-model", windows)).toBe("unknown-model");
    expect(withOneMillionMarker(undefined, windows)).toBeUndefined();
  });

  test("effectiveModelEnv emits the exact six-slot map with the effective-haiku contract", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000, "mock/small-model": 128_000 };
    const env = effectiveModelEnv({
      model: "cursor/gpt-5.6-luna",
      smallFastModel: "mock/small-model",
      tierModels: { opus: "cursor/gpt-5.6-luna", sonnet: "mock/small-model" },
    }, windows);
    expect(env.ANTHROPIC_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("mock/small-model");
    // effective-haiku: tierModels.haiku absent -> smallFastModel feeds BOTH haiku vars.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/small-model");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/small-model");
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
  });

  test("tierModels.haiku wins over smallFastModel for both haiku vars", () => {
    const env = effectiveModelEnv({ smallFastModel: "a", tierModels: { haiku: "b" } }, {});
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("b");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("b");
  });

  test("boundedContextWindows resolves null on a slow acquisition (deterministic delay fixture)", async () => {
    const slow = () => new Promise<Record<string, number>>(resolve => setTimeout(() => resolve({ x: 1 }), 200));
    expect(await boundedContextWindows(slow, 20)).toBeNull();
    expect(await boundedContextWindows(async () => ({ y: 2 }), 1_000)).toEqual({ y: 2 });
    expect(await boundedContextWindows(async () => { throw new Error("boom"); }, 1_000)).toBeNull();
  });
});
