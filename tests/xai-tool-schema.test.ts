import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxTool } from "../src/types";

function parsedRequest(tool: OcxTool): Parameters<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>[0] {
  return {
    modelId: "grok-4.6",
    context: {
      messages: [
        {
          role: "user",
          content: "run the command",
          timestamp: 0,
        },
      ],
      tools: [tool],
    },
    stream: true,
    options: {},
  } as never;
}

function xaiAdapter() {
  return createOpenAIChatAdapter({
    adapter: "openai-chat",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    apiKey: "k",
  });
}

describe("xAI Grok CLI tool schema normalization", () => {
  test("keeps Claude Code tools with a root $schema", () => {
    const tool: OcxTool = {
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          command: {
            type: "string",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    };

    const body = JSON.parse(
      xaiAdapter().buildRequest(parsedRequest(tool)).body,
    ) as {
      tools?: Array<{
        type: string;
        function: {
          name: string;
          parameters: Record<string, unknown>;
        };
      }>;
    };

    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.function.name).toBe("Bash");
    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    expect(body.tools?.[0]?.function.parameters).not.toHaveProperty("$schema");
  });

  test("does not reintroduce $schema when flattening a root union", () => {
    const tool: OcxTool = {
      name: "Bash",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [
          {
            type: "object",
            properties: {
              command: {
                type: "string",
              },
            },
            required: ["command"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              command: {
                type: "string",
                minLength: 1,
              },
            },
            required: ["command"],
            additionalProperties: false,
          },
        ],
      },
    };

    const body = JSON.parse(
      xaiAdapter().buildRequest(parsedRequest(tool)).body,
    ) as {
      tools?: Array<{
        function: {
          parameters: Record<string, unknown>;
        };
      }>;
    };

    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.function.parameters).not.toHaveProperty("$schema");
    expect(body.tools?.[0]?.function.parameters).not.toHaveProperty("oneOf");
  });
});