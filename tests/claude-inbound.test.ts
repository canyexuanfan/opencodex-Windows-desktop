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
    // Stable per-session cache-affinity key derived from metadata.user_id (devlog 090)
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
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

  test("adaptive /effort wire: output_config.effort maps to reasoning.effort (devlog 080)", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const reasoningOf = (body: unknown) => (body as { reasoning?: Record<string, unknown> }).reasoning;
    // Real claude 2.1.207 capture: thinking adaptive + output_config effort
    expect(reasoningOf(anthropicToResponsesBody({
      ...base,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    }))).toEqual({ summary: "auto", effort: "high" });
    // effort passes through the whole known ladder
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(reasoningOf(anthropicToResponsesBody({
        ...base, thinking: { type: "adaptive" }, output_config: { effort },
      }))).toEqual({ summary: "auto", effort });
    }
    // output_config alone (adaptive-default models may omit thinking) still carries effort
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, output_config: { effort: "medium" },
    }))).toEqual({ summary: "auto", effort: "medium" });
    // output_config wins over a legacy budget when both appear
    expect(reasoningOf(anthropicToResponsesBody({
      ...base,
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "xhigh" },
    }))).toEqual({ summary: "auto", effort: "xhigh" });
    // disabled thinking suppresses effort entirely (subagent wire, claude-code#65863)
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "disabled" }, output_config: { effort: "high" },
    }))).toBeUndefined();
    // unknown effort strings are dropped so downstream defaults win
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "adaptive" }, output_config: { effort: "turbo" },
    }))).toEqual({ summary: "auto" });
  });

  test("tool_choice any/tool/none", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "any" } }) as any).tool_choice).toBe("required");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "none" } }) as any).tool_choice).toBe("none");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "tool", name: "Read" } }) as any).tool_choice)
      .toEqual({ type: "function", name: "Read" });
  });

  test("system role messages fold into instructions (real Claude Code sends them; native backend rejects system items)", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      system: "top-level",
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: [{ type: "text", text: "block form" }] },
        { role: "user", content: "hi" },
      ],
    }) as any;
    expect(body.instructions).toBe("top-level\n\nbe terse\n\nblock form");
    // No system message items in input — native ChatGPT backend 400s on them.
    expect((body.input as any[]).every(item => item.role !== "system")).toBe(true);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].role).toBe("user");
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
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
    // system role is ACCEPTED (real Claude Code sends it); truly unknown roles still 400.
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [{ role: "system", content: "x" }] })).not.toThrow();
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [{ role: "tool", content: "x" }] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({
      model: "m", max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "tool_result" }] }],
    })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody("nope")).toThrow(AnthropicRequestError);
  });
});
