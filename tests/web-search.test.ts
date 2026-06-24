import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch } from "../src/web-search";
import { headersForCodexAuthContext } from "../src/codex-auth-context";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

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
      { kind: "pool", accountId: "pool-a", accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      selectedHeaders,
      routedProvider,
      "model",
      { kind: "pool", accountId: "pool-a", accessToken: "pool-token", chatgptAccountId: "pool_acc" },
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
