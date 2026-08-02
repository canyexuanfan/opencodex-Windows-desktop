// 260715 issue #126: NVIDIA NIM hardening — parallel_tool_calls opt-out, kimi
// reasoning_effort suppression, and openai-chat formatErrorBody detail surfacing.
// Plan/evidence: devlog/_plan/260715_issue126_nim_kimi.
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, formatOpenAIChatErrorBody } from "../src/adapters/openai-chat";
import { applyProviderConfigHints, normalizeRoutedCatalogEntry } from "../src/codex/catalog";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxTool } from "../src/types";

const tools: OcxTool[] = [{ name: "shell", description: "run", parameters: { type: "object" } }];

function nvidiaConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "nvidia",
    providers: {
      // Bare persisted config, like `ocx init` writes: registry seeds must backfill the flags.
      nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "k" },
    },
  };
}

function parsedFor(modelId: string, options: Partial<OcxParsedRequest["options"]> = {}): Parameters<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>[0] {
  return {
    modelId,
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools,
    },
    stream: true,
    options: { ...options },
  } as never;
}

describe("nvidia NIM registry hardening (issue #126)", () => {
  test("bare persisted nvidia config inherits parallelToolCalls:false from the registry", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    expect(route.provider.parallelToolCalls).toBe(false);
    expect(route.modelId).toBe("moonshotai/kimi-k2.6");
  });

  test("kimi-k2.6 request drops reasoning_effort and pins parallel_tool_calls:false", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    const adapter = createOpenAIChatAdapter(route.provider);
    const body = JSON.parse(adapter.buildRequest(parsedFor(route.modelId, { reasoning: "medium" })).body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.model).toBe("moonshotai/kimi-k2.6");
  });

  test("whole documented NIM kimi family suppresses reasoning_effort", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    for (const id of [
      "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking",
      "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905",
    ]) {
      const adapter = createOpenAIChatAdapter(route.provider);
      const body = JSON.parse(adapter.buildRequest(parsedFor(id, { reasoning: "high" })).body) as Record<string, unknown>;
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("gpt-oss on NIM keeps its working reasoning_effort (exact-id scoping)", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/openai/gpt-oss-120b");
    const adapter = createOpenAIChatAdapter(route.provider);
    const body = JSON.parse(adapter.buildRequest(parsedFor(route.modelId, { reasoning: "medium" })).body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("NIM kimi thinking family preserves reasoning_content in chat history", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    expect(route.provider.preserveReasoningContentModels).toContain("moonshotai/kimi-k2.6");
    expect(route.provider.preserveReasoningContentModels).toContain("moonshotai/kimi-k2-thinking");
    expect(route.provider.preserveReasoningContentModels).not.toContain("moonshotai/kimi-k2-instruct");
  });

  test("catalog bit: nvidia routed entries stop advertising supports_parallel_tool_calls", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    const hinted = applyProviderConfigHints(
      "nvidia",
      route.provider,
      { id: "moonshotai/kimi-k2.6", provider: "nvidia" },
    );
    expect(hinted.parallelToolCalls).toBeUndefined();
    const entry = normalizeRoutedCatalogEntry({ slug: "nvidia/moonshotai/kimi-k2.6" }, hinted.parallelToolCalls);
    expect(entry.supports_parallel_tool_calls).toBe(false);
  });
});

describe("formatOpenAIChatErrorBody (web-search sidecar detail surfacing)", () => {
  test("OpenAI error object shape", () => {
    expect(formatOpenAIChatErrorBody(400, new Headers(), '{"error":{"message":"This model only supports single tool-calls at once!"}}'))
      .toBe("This model only supports single tool-calls at once!");
  });

  test("OpenAI error string shape", () => {
    expect(formatOpenAIChatErrorBody(401, new Headers(), '{"error":"invalid key"}')).toBe("invalid key");
  });

  test("FastAPI string detail (NIM)", () => {
    expect(formatOpenAIChatErrorBody(404, new Headers(), '{"detail":"Not Found"}')).toBe("Not Found");
  });

  test("pydantic validation array detail (NIM extra_forbidden)", () => {
    const body = '{"detail":[{"loc":["body","max_new_tokens"],"msg":"extra fields not permitted","type":"extra_forbidden"},{"loc":["body","x"],"msg":"value error","type":"value_error"}]}';
    expect(formatOpenAIChatErrorBody(400, new Headers(), body)).toBe("extra fields not permitted; value error");
  });

  test("generic message / RFC7807 title fallbacks", () => {
    expect(formatOpenAIChatErrorBody(400, new Headers(), '{"message":"quota exceeded"}')).toBe("quota exceeded");
    expect(formatOpenAIChatErrorBody(404, new Headers(), '{"title":"Not Found","status":404}')).toBe("Not Found");
  });

  test("HTML and non-JSON bodies are never echoed", () => {
    expect(formatOpenAIChatErrorBody(502, new Headers(), "<html><body>Bad gateway</body></html>")).toBe("");
    expect(formatOpenAIChatErrorBody(500, new Headers(), "plain text panic")).toBe("");
  });

  test("secret-shaped values are redacted", () => {
    const out = formatOpenAIChatErrorBody(401, new Headers(), '{"error":{"message":"key sk-abcdef1234567890 rejected"}}');
    expect(out).not.toContain("sk-abcdef1234567890");
    expect(out).toContain("[REDACTED]");
  });

  test("caps output at 400 chars", () => {
    const long = JSON.stringify({ error: { message: "x".repeat(1000) } });
    expect(formatOpenAIChatErrorBody(400, new Headers(), long).length).toBe(400);
  });
});
