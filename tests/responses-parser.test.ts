import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

describe("Responses parser", () => {
  test("preserves allowed_tools tool_choice instead of widening it to auto", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        {
          type: "function",
          name: "run_tests",
          description: "Run tests",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "web_search" }],
      },
    });

    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });

  test("maps hosted allowed_tools entries to their synthetic routed tool names", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search" }],
      },
    });

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });
});
