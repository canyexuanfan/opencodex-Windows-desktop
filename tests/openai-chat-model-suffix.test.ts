import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, stripBracketedModelSuffix } from "../src/adapters/openai-chat";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function openaiChatProvider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
  };
}

function anthropicProvider(): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
  };
}

function wireModel(req: ReturnType<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>): unknown {
  return (JSON.parse(req.body as string) as Record<string, unknown>).model;
}

describe("stripBracketedModelSuffix", () => {
  test("strips a trailing [..] suffix", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m]")).toBe("glm-5.2");
  });

  test("leaves a bare id untouched", () => {
    expect(stripBracketedModelSuffix("glm-5.2")).toBe("glm-5.2");
  });

  test("strips trailing suffix with trailing whitespace", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m] ")).toBe("glm-5.2");
  });

  test("does not strip an interior bracket group", () => {
    expect(stripBracketedModelSuffix("a[b]c")).toBe("a[b]c");
  });

  test("empty bracket group is still stripped", () => {
    expect(stripBracketedModelSuffix("model[]")).toBe("model");
  });
});

describe("openai-chat adapter wire model normalization", () => {
  test("glm-5.2[1m] is sent as bare glm-5.2", () => {
    const req = createOpenAIChatAdapter(openaiChatProvider()).buildRequest(parsed("glm-5.2[1m]"));
    expect(wireModel(req)).toBe("glm-5.2");
  });

  test("bare glm-5.2 passes through unchanged", () => {
    const req = createOpenAIChatAdapter(openaiChatProvider()).buildRequest(parsed("glm-5.2"));
    expect(wireModel(req)).toBe("glm-5.2");
  });
});

describe("anthropic adapter leaves the bracketed suffix intact", () => {
  test("glm-5.2[1m] is sent verbatim", () => {
    const req = createAnthropicAdapter(anthropicProvider()).buildRequest(parsed("glm-5.2[1m]"));
    const model = (JSON.parse(req.body as string) as Record<string, unknown>).model;
    expect(model).toBe("glm-5.2[1m]");
  });
});
