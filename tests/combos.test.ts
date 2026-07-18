import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboSelectionState,
  comboModelId,
  getCombo,
  isValidComboId,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseComboModelId,
  pickComboTarget,
  targetKey,
  tryPickComboModel,
} from "../src/combos";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

function rrConfig(stickyLimit: number, weights: number[]): OcxConfig {
  const providers = baseConfig().providers;
  const names = ["a", "b", "c"];
  return baseConfig({
    providers,
    combos: {
      free: {
        strategy: "round-robin",
        stickyLimit,
        targets: weights.map((weight, index) => ({
          provider: names[index]!,
          model: `m${index + 1}`,
          weight,
        })),
      },
    },
  });
}

function successfulPicks(config: OcxConfig, count: number): string[] {
  const combo = getCombo(config, "free")!;
  return Array.from({ length: count }, () => {
    const pick = pickComboTarget(config, "free")!;
    noteComboSuccess("free", combo, pick.target);
    return targetKey(pick.target);
  });
}

afterEach(() => clearComboSelectionState());

describe("combo namespace primitives", () => {
  test("parses and formats combo model ids", () => {
    expect(parseComboModelId("combo/free")).toBe("free");
    expect(parseComboModelId("combo/  free  ")).toBe("  free  ");
    expect(parseComboModelId("combo/")).toBeNull();
    expect(parseComboModelId("nvidia/free")).toBeNull();
    expect(comboModelId("free")).toBe("combo/free");
  });

  test("checks source combo ids and target keys", () => {
    expect(isValidComboId("free.v1_2-x")).toBe(true);
    expect(isValidComboId("-free")).toBe(false);
    expect(targetKey({ provider: "a", model: "m1" })).toBe("a/m1");
  });
});

describe("deterministic combo selection", () => {
  test("equal-weight RR rotates exactly", () => {
    const config = rrConfig(1, [1, 1, 1]);
    expect(successfulPicks(config, 6)).toEqual([
      "a/m1", "b/m2", "c/m3", "a/m1", "b/m2", "c/m3",
    ]);
  });

  test("smooth weights and sticky successes have a deterministic sequence", () => {
    const config = rrConfig(2, [2, 1]);
    expect(successfulPicks(config, 12)).toEqual([
      "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
      "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
    ]);
  });

  test("repeated picks and production routing remain pinned without success", () => {
    const config = rrConfig(1, [1, 1]);
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
    expect(routeModel(config, "combo/free").providerName).toBe("a");
    expect(routeModel(config, "combo/free").providerName).toBe("a");
  });

  test("eligibility, exclusions, and state reset are deterministic", () => {
    const config = rrConfig(1, [1, 1]);
    expect(pickComboTarget(config, "free", { exclude: ["a/m1"] })?.target.provider).toBe("b");
    clearComboSelectionState("free");
    expect(pickComboTarget(config, "free", { eligible: target => target.provider !== "a" })?.target.provider).toBe("b");
    clearComboSelectionState("free");
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
  });

  test("disabled members are skipped and an all-disabled combo fails closed", () => {
    const config = baseConfig();
    config.providers.a!.disabled = true;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
    config.providers.b!.disabled = true;
    expect(() => tryPickComboModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
    expect(() => routeModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
  });

  test("missing members are skipped after unsupported in-memory corruption", () => {
    const config = baseConfig();
    delete config.providers.a;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
  });
});
