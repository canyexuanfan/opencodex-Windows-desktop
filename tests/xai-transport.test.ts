import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import { buildModelsRequest } from "../src/oauth";
import {
  resolveProviderTransport,
  deriveXaiConvId,
  XAI_CONV_ID_HEADER,
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../src/providers/xai-transport";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxAssistantMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(authMode: "oauth" | "key"): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode,
    apiKey: authMode === "oauth" ? "oauth-token" : "xai-api-key",
    defaultModel: "grok-4.5",
  };
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "grok-4.5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "low" },
  };
}

describe("xAI auth-mode transport selection", () => {
  test("OAuth selects the Grok CLI subscription transport and required headers", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"));
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe(XAI_GROK_CLI_BASE_URL);
    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/chat/completions`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("OAuth model discovery uses the subscription transport", () => {
    const request = buildModelsRequest(provider("oauth"), "oauth-token", "xai");

    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/models`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("API key keeps the xAI API transport without subscription headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured);
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
    const modelsRequest = buildModelsRequest(configured, "xai-api-key", "xai");

    expect(effective).toBe(configured);
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(modelsRequest.url).toBe("https://api.x.ai/v1/models");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer xai-api-key",
    });
    expect(modelsRequest.headers).toEqual({ Authorization: "Bearer xai-api-key" });
  });

  test("custom providers and configured header overrides remain untouched", () => {
    const custom = provider("oauth");
    custom.headers = { "x-grok-client-version": "0.2.94", "x-custom": "kept" };

    expect(resolveProviderTransport("custom-xai", custom)).toBe(custom);
    expect(resolveProviderTransport("xai", custom).headers).toMatchObject({
      "x-grok-client-version": "0.2.94",
      "x-custom": "kept",
      "x-grok-client-identifier": "opencodex",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("flattens nested root tool unions for xAI without changing other providers", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { mode: { type: "string", enum: ["view"] } } },
        { oneOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "object", properties: {} }] },
      ],
      $defs: { shared: { type: "string" } },
    };
    const request = createOpenAIChatAdapter(provider("key")).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    const xaiParameters = (JSON.parse(request.body) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools[0].function.parameters;

    expect(xaiParameters.type).toBeUndefined();
    expect(xaiParameters.oneOf).toHaveLength(3);
    expect((xaiParameters.oneOf as Record<string, unknown>[]).every(branch => branch.type === "object")).toBe(true);
    expect(xaiParameters.$defs).toEqual(schema.$defs);

    const otherRequest = createOpenAIChatAdapter({ ...provider("key"), baseUrl: "https://example.test/v1" }).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect((JSON.parse(otherRequest.body) as { tools: Array<{ function: { parameters: unknown } }> }).tools[0].function.parameters).toEqual(schema);
  });

  test("omits an xAI tool whose root schema cannot be normalized safely", () => {
    const request = createOpenAIChatAdapter(provider("key")).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "unsafe", description: "Unsafe", parameters: { oneOf: [{ type: "string" }] } }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("normalizes a tool loaded from tool_search history on later turns", () => {
    const parsedRequest = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "tool_search_call", call_id: "search-1", arguments: { query: "automation" } },
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          tools: [{
            type: "function",
            name: "automation_update",
            description: "Update an automation",
            parameters: { oneOf: [{ type: "object", properties: {} }, { oneOf: [{ type: "object", properties: {} }] }] },
          }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
    const request = createOpenAIChatAdapter(provider("key")).buildRequest(parsedRequest);
    const body = JSON.parse(request.body) as { tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> };
    const tool = body.tools.find(entry => entry.function.name === "automation_update");

    expect(tool?.function.parameters.oneOf).toHaveLength(2);
    expect((tool?.function.parameters.oneOf as Record<string, unknown>[]).every(branch => branch.type === "object")).toBe(true);
  });
});

describe("xAI prompt-cache conv-id affinity", () => {
  test("promptCacheKey derives a stable hashed x-grok-conv-id in oauth mode", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");
    const again = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");

    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    // Stable across requests (cache affinity) and never the raw session id.
    expect(again.headers?.[XAI_CONV_ID_HEADER]).toBe(effective.headers?.[XAI_CONV_ID_HEADER]);
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).not.toContain("codex-session-abc");
  });

  test("key mode gains conv-id affinity without touching baseUrl or CLI headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured, "codex-session-abc");
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe("https://api.x.ai/v1");
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.["x-grok-client-identifier"]).toBeUndefined();
    expect(effective.headers?.["x-grok-client-version"]).toBeUndefined();
    expect(effective.headers?.["x-xai-token-auth"]).toBeUndefined();
    for (const [name, value] of Object.entries(request.headers)) {
      expect(name).not.toContain("codex-session-abc");
      expect(value).not.toContain("codex-session-abc");
    }
  });

  test("missing, empty, and whitespace-only cache keys never emit a conv-id", () => {
    const noKeyOauth = resolveProviderTransport("xai", provider("oauth"));
    const emptyKeyOauth = resolveProviderTransport("xai", provider("oauth"), "");
    const blankKeyOauth = resolveProviderTransport("xai", provider("oauth"), "   ");
    const configuredKey = provider("key");
    const emptyKeyApi = resolveProviderTransport("xai", configuredKey, "");

    expect(noKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(emptyKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(blankKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    // Key mode without a conv-id stays the exact configured object (no clone churn).
    expect(emptyKeyApi).toBe(configuredKey);
  });

  test("user-configured conv-id header wins in any casing (no duplicate header pair)", () => {
    const lower = provider("oauth");
    lower.headers = { [XAI_CONV_ID_HEADER]: "user-pinned" };
    const mixed = provider("key");
    mixed.headers = { "X-Grok-Conv-Id": "user-pinned-mixed" };

    const lowerResolved = resolveProviderTransport("xai", lower, "codex-session-abc");
    const mixedResolved = resolveProviderTransport("xai", mixed, "codex-session-abc");

    expect(lowerResolved.headers?.[XAI_CONV_ID_HEADER]).toBe("user-pinned");
    // Mixed casing: the generated lowercase header must be suppressed entirely.
    expect(mixedResolved.headers?.["X-Grok-Conv-Id"]).toBe("user-pinned-mixed");
    expect(mixedResolved.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    const convIdKeys = Object.keys(mixedResolved.headers ?? {}).filter(k => k.toLowerCase() === XAI_CONV_ID_HEADER);
    expect(convIdKeys).toHaveLength(1);
  });

  test("mixed-case user override of a Grok CLI default header suppresses the default", () => {
    const custom = provider("oauth");
    custom.headers = { "X-Grok-Client-Version": "0.2.94" };

    const resolved = resolveProviderTransport("xai", custom);
    const versionKeys = Object.keys(resolved.headers ?? {}).filter(k => k.toLowerCase() === "x-grok-client-version");
    expect(versionKeys).toEqual(["X-Grok-Client-Version"]);
    expect(resolved.headers?.["X-Grok-Client-Version"]).toBe("0.2.94");
    // Untouched defaults still apply.
    expect(resolved.headers?.["x-grok-client-identifier"]).toBe("opencodex");
  });
});

describe("xAI reasoning_content cache preservation", () => {
  test("registry preset replays reasoning_content for grok reasoning models only", () => {
    const entry = getProviderRegistryEntry("xai");
    expect(entry?.preserveReasoningContentModels).toEqual([
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-multi-agent-0309",
      "grok-4.20-0309-reasoning",
    ]);
    for (const noReasoning of entry?.noReasoningModels ?? []) {
      expect(entry?.preserveReasoningContentModels).not.toContain(noReasoning);
    }
  });

  test("parseRequest folds summary reasoning into one Grok assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "cached chain" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "cached chain" });
  });

  test("parseRequest drops opaque encrypted-only reasoning without detaching an assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-opaque", summary: [], encrypted_content: "opaque-native-blob" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ role: "assistant", content: "answer" });
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest clears pending reasoning at a user boundary", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r-orphan", summary: [{ type: "summary_text", text: "must drop" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toEqual([{ role: "assistant", content: "answer" }]);
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest folds pending reasoning into the assistant turn that carries the call", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r-call", summary: [{ type: "summary_text", text: "call chain" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(2);
    // Grok wire shape: a reasoning model emits reasoning_content and tool_calls on the SAME
    // assistant message (and Anthropic replay requires thinking before tool_use in one turn).
    expect(assistants[0]).toMatchObject({
      reasoning_content: "call chain",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
    });
    expect(assistants[1]).toMatchObject({ content: "answer" });
    expect(assistants[1]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest newline-joins reasoning siblings before one assistant", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "first" }] },
        { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "second" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");
    const parsedAssistant = req.context.messages.find(message => message.role === "assistant") as OcxAssistantMessage;
    const thinkingParts = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]).toMatchObject({ thinking: "first\nsecond", itemId: "r2" });
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "first\nsecond" });
  });

  test("parseRequest drops trailing reasoning without creating an assistant", () => {
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-trailing", summary: [{ type: "summary_text", text: "unfinished" }] },
      ],
    });

    expect(req.context.messages.filter(message => message.role === "assistant")).toHaveLength(0);
    expect(req.context.messages).toHaveLength(1);
  });
});
