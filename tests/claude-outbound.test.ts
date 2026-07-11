import { describe, expect, test } from "bun:test";
import {
  anthropicErrorBody,
  anthropicErrorType,
  anthropicUsage,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
} from "../src/claude/outbound";

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Split into odd chunks so frame-boundary buffering is exercised.
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<{ name: string; data: Record<string, any> }[]> {
  const text = await new Response(stream).text();
  const events: { name: string; data: Record<string, any> }[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

describe("claude outbound SSE", () => {
  test("text + thinking + tool call + completed w/ usage -> exact Anthropic sequence", async () => {
    const upstream = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "hmm" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1" } }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hello " }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "world" }),
      sse("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg_1" } }),
      sse("response.output_item.added", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "toolu_9", name: "Read", arguments: "", status: "in_progress" } }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "{\"file_path\":" }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "\"/x\"}" }),
      sse("response.output_item.done", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "toolu_9", name: "Read" } }),
      sse("response.heartbeat", {}),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 } } } }),
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "claude-ocx-test"));
    const names = events.map(e => e.name);
    expect(names).toEqual([
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // thinking (+signature)
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // text
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // tool_use
      "ping",
      "message_delta", "message_stop",
    ]);

    const start = events[0].data;
    expect(start.type).toBe("message_start");
    expect(start.message).toMatchObject({ type: "message", role: "assistant", content: [], model: "claude-ocx-test", stop_reason: null });

    // thinking block: index 0, thinking_delta then synthetic signature_delta before stop
    expect(events[2].data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(events[3].data.delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
    expect(events[4].data.delta.type).toBe("signature_delta");
    expect(events[4].data.delta.signature.length).toBeGreaterThan(0);
    expect(events[5].data).toEqual({ type: "content_block_stop", index: 0 });

    // text block: index 1
    expect(events[6].data.content_block).toEqual({ type: "text", text: "" });
    expect(events[7].data.delta).toEqual({ type: "text_delta", text: "Hello " });

    // tool_use block: index 2, id = call_id
    expect(events[10].data.content_block).toMatchObject({ type: "tool_use", id: "toolu_9", name: "Read", input: {} });
    expect(events[11].data.delta).toEqual({ type: "input_json_delta", partial_json: "{\"file_path\":" });

    // message_delta: tool_use stop reason + mapped usage (input minus cache read+write)
    const md = events[names.indexOf("message_delta")].data;
    expect(md.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    expect(md.usage).toEqual({ input_tokens: 15, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });

    // monotonic block indexes
    const startIndexes = events.filter(e => e.name === "content_block_start").map(e => e.data.index);
    expect(startIndexes).toEqual([0, 1, 2]);
  });

  test("failed -> error event with taxonomy type", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "par" }),
      sse("response.failed", { response: { status: "failed", error: { status: 429, message: "rate limited" } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const names = events.map(e => e.name);
    // open text block is closed before the error event
    expect(names).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "error"]);
    expect(events.at(-1)!.data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
  });

  test("incomplete(max_output_tokens) -> max_tokens; EOF w/o terminal -> clean end_turn close", async () => {
    const incomplete = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "x" }),
      sse("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 6 } } }),
    ].join("");
    const e1 = await collectEvents(responsesSseToAnthropicSse(streamFrom(incomplete), "m"));
    const md1 = e1.find(e => e.name === "message_delta")!.data;
    expect(md1.delta.stop_reason).toBe("max_tokens");
    expect(e1.at(-1)!.name).toBe("message_stop");

    const eof = sse("response.created", { response: {} }) + sse("response.output_text.delta", { delta: "y" });
    const e2 = await collectEvents(responsesSseToAnthropicSse(streamFrom(eof), "m"));
    expect(e2.map(e => e.name)).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(e2.find(e => e.name === "message_delta")!.data.delta.stop_reason).toBe("end_turn");
  });

  test("no-output completed still emits a valid empty message", async () => {
    const upstream = sse("response.created", { response: {} }) + sse("response.completed", { response: { status: "completed" } });
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.map(e => e.name)).toEqual(["message_start", "ping", "message_delta", "message_stop"]);
    expect(events[2].data.delta.stop_reason).toBe("end_turn");
  });
});

describe("claude outbound non-stream + helpers", () => {
  test("responses JSON -> anthropic message", () => {
    const msg = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "think" }] },
        { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", id: "f", call_id: "toolu_1", name: "Read", arguments: "{\"a\":1}" },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    }, "claude-ocx-x") as any;
    expect(msg.type).toBe("message");
    expect(msg.model).toBe("claude-ocx-x");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0]).toMatchObject({ type: "thinking", thinking: "think" });
    expect(msg.content[1]).toEqual({ type: "text", text: "hi" });
    expect(msg.content[2]).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { a: 1 } });
    expect(msg.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test("error taxonomy table", () => {
    expect(anthropicErrorType(400)).toBe("invalid_request_error");
    expect(anthropicErrorType(401)).toBe("authentication_error");
    expect(anthropicErrorType(403)).toBe("permission_error");
    expect(anthropicErrorType(404)).toBe("not_found_error");
    expect(anthropicErrorType(413)).toBe("request_too_large");
    expect(anthropicErrorType(429)).toBe("rate_limit_error");
    expect(anthropicErrorType(500)).toBe("api_error");
    expect(anthropicErrorType(502)).toBe("api_error");
    expect(anthropicErrorType(529)).toBe("overloaded_error");
    expect(anthropicErrorType(418)).toBe("invalid_request_error");
    expect(anthropicErrorBody(429, "slow down")).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });

  test("usage mapping tolerates missing fields", () => {
    expect(anthropicUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(anthropicUsage({ input_tokens: 7, output_tokens: 2 })).toEqual({ input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
});
