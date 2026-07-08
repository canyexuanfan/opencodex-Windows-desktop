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

describe("anthropic tool input_schema normalization", () => {
  test("a parameterless tool (empty schema) gets a valid object input_schema", () => {
    const [tool] = toolsOf([{ name: "get_time", description: "current time", parameters: {} }]);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties).toEqual({});
  });

  test("a schema missing type gains type:object while keeping properties", () => {
    const [tool] = toolsOf([{
      name: "search",
      description: "search",
      parameters: { properties: { q: { type: "string" } }, required: ["q"] },
    }]);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties).toEqual({ q: { type: "string" } });
    expect(tool.input_schema.required).toEqual(["q"]);
  });

  test("an already-valid object schema passes through untouched", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const [tool] = toolsOf([{ name: "read_file", description: "read", parameters: { ...schema } }]);
    expect(tool.input_schema).toEqual(schema);
  });

  test("object schema with type but no properties gains an empty properties map", () => {
    const [tool] = toolsOf([{ name: "noop", description: "noop", parameters: { type: "object" } }]);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties).toEqual({});
  });
});
