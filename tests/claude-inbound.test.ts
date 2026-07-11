import { describe, expect, test } from "bun:test";
import { AnthropicRequestError, anthropicToResponsesBody, effortForThinkingBudget, resolveInboundModel } from "../src/claude/inbound";
import { parseRequest } from "../src/responses/parser";
import { responsesRequestSchema } from "../src/responses/schema";

// Full Claude Code-shaped request: system array, tool cycle, image, thinking, options.
function claudeCodeRequest(): Record<string, unknown> {
  return {
    model: "gemini/gemini-3-pro",
    max_tokens: 8192,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code." },
      { type: "text", text: "Prefer terse answers." },
    ],
    messages: [
      { role: "user", content: "read the README" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read it", signature: "sig123" },
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "# hello" }] },
          { type: "text", text: "now summarize" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aWc=" } },
        ],
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    thinking: { type: "enabled", budget_tokens: 10000 },
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ["STOP"],
    metadata: { user_id: "user-abc" },
  };
}

describe("claude inbound translation", () => {
  test("full Claude Code request passes the real responses schema AND parseRequest", () => {
    const body = anthropicToResponsesBody(claudeCodeRequest());
    // The hard gate: the translated body must be accepted by the real request pipeline.
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("content/tool/option mapping round-trips", () => {
    const body = anthropicToResponsesBody(claudeCodeRequest()) as Record<string, any>;
    expect(body.model).toBe("gemini/gemini-3-pro");
    expect(body.instructions).toBe("You are Claude Code.\n\nPrefer terse answers.");
    expect(body.max_output_tokens).toBe(8192);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBeUndefined(); // documented drop
    expect(body.stop).toEqual(["STOP"]);
    expect(body.user).toBe("user-abc");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe("auto");
    expect(body.reasoning).toEqual({ summary: "auto", effort: "medium" });

    const tools = body.tools as Record<string, any>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: "function", name: "Read", description: "Read a file",
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    });
    expect(tools[1]).toEqual({ type: "web_search" });

    const input = body.input as Record<string, any>[];
    // user text, assistant text (thinking dropped), function_call, function_call_output, user tail
    expect(input.map(i => i.type ?? i.role)).toEqual(["message", "message", "function_call", "function_call_output", "message"]);
    expect(input[1].content).toEqual([{ type: "output_text", text: "Reading it now." }]);
    expect(input[2]).toMatchObject({ call_id: "toolu_01", name: "Read", arguments: JSON.stringify({ file_path: "/README.md" }) });
    expect(input[3]).toMatchObject({ call_id: "toolu_01", output: [{ type: "input_text", text: "# hello" }] });
    const tail = input[4].content as Record<string, any>[];
    expect(tail[0]).toEqual({ type: "input_text", text: "now summarize" });
    expect(tail[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,aWc=" });
  });

  test("thinking variants", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "adaptive" } }) as any).reasoning).toEqual({ summary: "auto" });
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "disabled" } }) as any).reasoning).toBeUndefined();
    expect((anthropicToResponsesBody(base) as any).reasoning).toBeUndefined();
    expect(effortForThinkingBudget(1024)).toBe("low");
    expect(effortForThinkingBudget(8192)).toBe("medium");
    expect(effortForThinkingBudget(30000)).toBe("high");
  });

  test("tool_choice any/tool/none", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "any" } }) as any).tool_choice).toBe("required");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "none" } }) as any).tool_choice).toBe("none");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "tool", name: "Read" } }) as any).tool_choice)
      .toEqual({ type: "function", name: "Read" });
  });

  test("tool_result is_error and string content", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
      ],
    }) as any;
    expect(body.input[1].output).toBe("[tool error] boom");
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("modelMap: exact, date-stripped, passthrough", () => {
    const cc = { modelMap: { "claude-sonnet-4-5": "gemini/gemini-3-flash", "claude-opus-4": "xai/grok-4" } };
    expect(resolveInboundModel("claude-sonnet-4-5", cc)).toBe("gemini/gemini-3-flash");
    expect(resolveInboundModel("claude-opus-4-20250514", cc)).toBe("xai/grok-4");
    expect(resolveInboundModel("gpt-5.5", cc)).toBe("gpt-5.5");
    expect(resolveInboundModel("anything", undefined)).toBe("anything");
  });

  test("error cases: no model, empty messages, bad role, bad tool_result", () => {
    expect(() => anthropicToResponsesBody({ max_tokens: 1, messages: [{ role: "user", content: "x" }] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [{ role: "system", content: "x" }] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({
      model: "m", max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "tool_result" }] }],
    })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody("nope")).toThrow(AnthropicRequestError);
  });
});
