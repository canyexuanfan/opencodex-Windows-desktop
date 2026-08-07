import { expect, test } from "bun:test";
import {
  VISION_REASONING_LEVELS,
  clampVisionReasoningToLadder,
  visionReasoningLadder,
  visionReasoningOptionsFor,
  type ModelInfo,
} from "../src/pages/dashboard-shared";

test("vision reasoning uses advertised model ladders and clamps unsupported persisted values", () => {
  const models: ModelInfo[] = [
    { id: "gpt-5.6-luna", provider: "openai", namespaced: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.4-mini", provider: "openai", namespaced: "gpt-5.4-mini", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  ];

  expect(visionReasoningLadder(models, "gpt-5.6-luna")).toEqual(VISION_REASONING_LEVELS);
  const mini = visionReasoningLadder(models, "gpt-5.4-mini");
  expect(mini).toEqual(["low", "medium", "high", "xhigh"]);
  expect(clampVisionReasoningToLadder(mini, "max")).toBe("xhigh");
  expect(clampVisionReasoningToLadder(mini, "high")).toBe("high");
  expect(visionReasoningOptionsFor(mini, "max")).toEqual(mini);
});

test("vision reasoning clamp matches the server for non-prefix ladders", () => {
  expect(clampVisionReasoningToLadder(["low", "high"], "medium")).toBe("low");
  expect(clampVisionReasoningToLadder(["high", "max"], "low")).toBe("high");
  expect(clampVisionReasoningToLadder(["low", "medium", "max"], "xhigh")).toBe("medium");
});

test("unknown vision model metadata stays permissive", () => {
  expect(visionReasoningLadder([], "custom/vision-model")).toEqual(VISION_REASONING_LEVELS);
});
