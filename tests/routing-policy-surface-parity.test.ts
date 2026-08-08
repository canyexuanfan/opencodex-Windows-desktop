import { describe, expect, test } from "bun:test";

import { chatCompletionsToResponsesBody } from "../src/chat/inbound";
import { anthropicToResponsesTranslation } from "../src/claude/inbound";
import { evidenceFromBody } from "../src/routing/request-evidence";

const MODEL = "policy/daily";
const EXPECTED_RICH_EVIDENCE = {
  toolsRequired: true,
  imageInputRequired: true,
};

describe("routing policy request evidence parity", () => {
  test("tools and image input produce the same evidence across Responses, Chat Completions, and Claude Messages", () => {
    const responsesBody = {
      model: MODEL,
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      }],
      tools: [{
        type: "function",
        name: "inspect",
        parameters: { type: "object", properties: {} },
      }],
    };

    const chatBody = chatCompletionsToResponsesBody({
      model: MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "inspect",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const claudeBody = anthropicToResponsesTranslation({
      model: MODEL,
      max_tokens: 128,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AA==",
            },
          },
        ],
      }],
      tools: [{
        name: "inspect",
        input_schema: { type: "object", properties: {} },
      }],
    }).body;

    expect(evidenceFromBody(responsesBody)).toEqual(EXPECTED_RICH_EVIDENCE);
    expect(evidenceFromBody(chatBody)).toEqual(EXPECTED_RICH_EVIDENCE);
    expect(evidenceFromBody(claudeBody)).toEqual(EXPECTED_RICH_EVIDENCE);
  });

  test("plain text without tools produces no hard routing evidence on every surface", () => {
    const responsesBody = {
      model: MODEL,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
    };

    const chatBody = chatCompletionsToResponsesBody({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });

    const claudeBody = anthropicToResponsesTranslation({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }).body;

    expect(evidenceFromBody(responsesBody)).toEqual({});
    expect(evidenceFromBody(chatBody)).toEqual({});
    expect(evidenceFromBody(claudeBody)).toEqual({});
  });
});
