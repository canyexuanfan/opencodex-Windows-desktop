import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function toolsOf(tools: OcxTool[]): Array<{ name: string; input_schema: Record<string, unknown> }> {
  const parsed: OcxParsedRequest = {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: {},
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools },
  };
  const { body } = createAnthropicAdapter(provider).buildRequest(parsed);
  const parsedBody = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
    tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
  };
  return parsedBody.tools;
}

function toolSchema(parameters: unknown): Record<string, unknown> {
  const [tool] = toolsOf([{ name: "sample_tool", description: "Sample", parameters } as OcxTool]);
  return tool.input_schema;
}

describe("anthropic tool input_schema normalization", () => {
  test("parameterless and type-less tools become valid object schemas", () => {
    expect(toolSchema({})).toEqual({ type: "object", properties: {} });
    expect(toolSchema({ properties: { query: { type: "string" } }, required: ["query"] })).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  test("an already-valid object schema passes through untouched", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    expect(toolSchema({ ...schema })).toEqual(schema);
  });

  test("object schema with type but no properties gains an empty properties map", () => {
    expect(toolSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
  });

  test("root oneOf and anyOf are flattened without promoting branch required fields", () => {
    const anyOf = toolSchema({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(anyOf.anyOf).toBeUndefined();
    expect(anyOf.oneOf).toBeUndefined();
    expect(anyOf.allOf).toBeUndefined();
    expect(anyOf).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    });

    expect(toolSchema({
      oneOf: [
        { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      ],
    })).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("root allOf merges required fields and preserves sibling schema metadata", () => {
    expect(toolSchema({
      title: "Search options",
      additionalProperties: false,
      properties: { existing: { type: "string" } },
      required: ["existing"],
      allOf: [
        { type: "object", properties: { limit: { type: "number" } }, required: ["limit"] },
        { type: "object", properties: { sort: { type: "string" } } },
      ],
    })).toEqual({
      title: "Search options",
      additionalProperties: false,
      type: "object",
      properties: {
        existing: { type: "string" },
        limit: { type: "number" },
        sort: { type: "string" },
      },
      required: ["existing", "limit"],
    });
  });

  test("nested composition under properties is preserved", () => {
    expect(toolSchema({
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    })).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
  });
});
