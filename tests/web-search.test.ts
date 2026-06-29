import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch } from "../src/web-search";
import { runWithWebSearch } from "../src/web-search/loop";
import { headersForCodexAuthContext } from "../src/codex-auth-context";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";

const routedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "routed-key",
};

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: routedProvider,
      chatgpt: forwardProvider,
    },
    ...overrides,
  };
}

function parsedWithWebSearch() {
  return parseRequest({
    model: "routed/model",
    input: "Search for current docs",
    stream: true,
    tools: [
      { type: "web_search", search_context_size: "medium" },
      { type: "function", name: "read_file", description: "Read file", parameters: {} },
    ],
  });
}

describe("web-search sidecar planning", () => {
  test("parseRequest stashes hosted web_search while keeping normal tools", () => {
    const parsed = parsedWithWebSearch();

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.context.tools?.map(t => t.name)).toEqual(["read_file"]);
  });

  test("planWebSearch activates only for routed requests with forward auth and incoming authorization", () => {
    const parsed = parsedWithWebSearch();
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      new Headers({ authorization: "Bearer chatgpt" }),
      routedProvider,
      "model",
    );

    expect(plan).toBeDefined();
    expect(plan?.forwardProvider).toBe(forwardProvider);
    expect(plan?.hostedTool).toEqual(parsed._webSearch);
    expect(plan?.settings.model).toBe("gpt-5.4-mini");
  });

  test("planWebSearch activates for pool-selected headers even when raw inbound auth would be main", () => {
    const parsed = parsedWithWebSearch();
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      selectedHeaders,
      routedProvider,
      "model",
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    expect(plan).toBeDefined();
    expect(selectedHeaders.get("authorization")).toBe("Bearer pool-token");
    expect(selectedHeaders.get("chatgpt-account-id")).toBe("pool_acc");
  });

  test("planWebSearch suppresses sidecar predictably when prerequisites are absent", () => {
    const parsed = parsedWithWebSearch();

    expect(planWebSearch(config(), parsed, true, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), parsed, false, new Headers(), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config({ providers: { routed: routedProvider } }), parsed, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config({ webSearchSidecar: { enabled: false } }), parsed, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), { ...parsed, _webSearch: undefined }, false, new Headers({ authorization: "Bearer x" }), routedProvider, "model")).toBeUndefined();
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

/** Adapter whose first non-stream pass returns the events, and every later (forceAnswer) pass a text answer. */
function scriptedAdapter(firstPass: AdapterEvent[]): ProviderAdapter {
  let pass = 0;
  return {
    name: "mock",
    buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
    async *parseStream() { /* unused */ },
    async parseResponse() {
      pass++;
      if (pass === 1) return firstPass;
      return [{ type: "text_delta", text: "final answer" }, { type: "done" }];
    },
  };
}

describe("web-search sidecar native web_search_call emission", () => {
  test("an executed search emits a web_search_call item ahead of the assistant message", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses: return a minimal completed SSE with answer text
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({ type: "web_search_call", action: { type: "search", query: "current docs" } });
  });

  test("empty-query and limit placeholders do NOT emit a web_search_call item", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    // First pass: an empty-query web_search call (handled by the empty-query branch, never hits the sidecar).
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "go", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_empty", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.some(item => item.type === "web_search_call")).toBe(false);
    expect(output.map(item => item.type)).toEqual(["message"]);
  });
});
