import { describe, expect, test } from "bun:test";
import {
  createReasoningSummaryChannelPayloadRewrite,
  routeUsesContentChannelReasoning,
  rewriteReasoningSummaryInJson,
  rewriteReasoningSummaryInJsonString,
} from "../src/server/responses-reasoning-summary-rewrite";

const rewrite = createReasoningSummaryChannelPayloadRewrite();

function apply(payload: unknown): unknown {
  return JSON.parse(rewrite(JSON.stringify(payload)));
}

describe("responses reasoning summary channel rewrite", () => {
  test("routes reasoning_text.delta through the summary channel", () => {
    expect(apply({
      type: "response.reasoning_text.delta",
      content_index: 0,
      delta: "think",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 4,
    })).toEqual({
      type: "response.reasoning_summary_text.delta",
      summary_index: 0,
      delta: "think",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 4,
    });
  });

  test("routes reasoning_text.done through the summary channel", () => {
    expect(apply({
      type: "response.reasoning_text.done",
      content_index: 0,
      text: "full thinking",
      item_id: "rs_1",
      output_index: 0,
    })).toEqual({
      type: "response.reasoning_summary_text.done",
      summary_index: 0,
      text: "full thinking",
      item_id: "rs_1",
      output_index: 0,
    });
  });

  test("moves reasoning item content into summary on output_item.done", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "thinking" }],
        summary: [],
      },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
    });
  });

  test("moves reasoning item content into summary inside response.completed", () => {
    const payload = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            status: "completed",
            content: [{ type: "reasoning_text", text: "thinking" }],
            summary: [],
          },
          { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "OK" }] },
        ],
      },
    };
    const result = apply(payload) as { response: { output: Record<string, unknown>[] } };
    expect(result.response.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      summary: [{ type: "summary_text", text: "thinking" }],
    });
    expect(result.response.output[1]).toEqual(payload.response.output[1]);
  });

  test("leaves summary-channel and message events untouched", () => {
    const untouched = [
      { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "s", item_id: "rs_1", output_index: 0 },
      { type: "response.output_text.delta", content_index: 0, delta: "OK", item_id: "msg_1", output_index: 1 },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", status: "in_progress", content: [] } },
    ];
    for (const payload of untouched) {
      expect(apply(payload)).toEqual(payload);
    }
  });

  test("leaves a reasoning item without content text untouched", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed", content: [], summary: [] },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed", content: [], summary: [] },
    });
  });

  test("preserves a summary-channel reasoning item as-is", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [],
        summary: [{ type: "summary_text", text: "already summarized" }],
      },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [],
        summary: [{ type: "summary_text", text: "already summarized" }],
      },
    });
  });

  test("rewrites reasoning items inside a bare completed response document", () => {
    const doc = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          content: [{ type: "reasoning_text", text: "thinking" }],
          summary: [],
        },
        { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "OK" }] },
      ],
    };
    const result = rewriteReasoningSummaryInJson(doc) as { output: Record<string, unknown>[] };
    expect(result.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      summary: [{ type: "summary_text", text: "thinking" }],
    });
    expect(result.output[1]).toEqual(doc.output[1]);
  });

  test("rewrites reasoning items inside an SSE completed event document", () => {
    const doc = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            status: "completed",
            content: [{ type: "reasoning_text", text: "thinking" }],
            summary: [],
          },
        ],
      },
    };
    const result = rewriteReasoningSummaryInJson(doc) as { response: { output: Record<string, unknown>[] } };
    expect(result.response.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      summary: [{ type: "summary_text", text: "thinking" }],
    });
  });

  test("string-level rewrite leaves summary-channel documents untouched", () => {
    const doc = JSON.stringify({
      id: "resp_1",
      output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "already summarized" }] }],
    });
    expect(rewriteReasoningSummaryInJsonString(doc)).toBe(doc);
  });

  test("malformed payloads pass through unchanged", () => {
    expect(rewrite("not json")).toBe("not json");
    expect(rewrite("[1,2]")).toBe("[1,2]");
  });
});

describe("routeUsesContentChannelReasoning", () => {
  test("statelessResponses providers use the content channel", () => {
    expect(routeUsesContentChannelReasoning({ statelessResponses: true }, "deepseek-v4-flash")).toBe(true);
  });

  test("preserveReasoningContentModels lists qualify", () => {
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["deepseek-v4-flash"] },
      "deepseek-v4-flash",
    )).toBe(true);
  });

  test("model matching is case-insensitive on both sides", () => {
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["DeepSeek-V4-Flash"] },
      "deepseek-v4-flash",
    )).toBe(true);
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["deepseek-v4-flash"] },
      "DeepSeek-V4-Flash",
    )).toBe(true);
  });

  test("other providers do not", () => {
    expect(routeUsesContentChannelReasoning({}, "gpt-5.5")).toBe(false);
  });
});
