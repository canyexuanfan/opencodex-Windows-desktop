import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  PartialToolCallUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { createCursorProtobufEventState, mapCursorProtobufServerMessage } from "../src/adapters/cursor/protobuf-events";

const encoder = new TextEncoder();

function interaction(message: Parameters<typeof create<typeof InteractionUpdateSchema>>[1]["message"]) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, { message }),
    },
  });
}

function mcpToolCall(toolName: string, args: Record<string, string>) {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encoder.encode(JSON.stringify(value));
  return create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, {
          name: toolName,
          toolName,
          toolCallId: "call_1",
          providerIdentifier: "opencodex-responses",
          args: encoded,
        }),
      }),
    },
  });
}

describe("Cursor protobuf tool-call events", () => {
  test("maps MCP tool-call updates to Cursor tool call messages", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_end", id: "call_1" }]);
  });

  test("treats partial tool-call args as aggregated text", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\"" }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\"" },
    ]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":\"a.txt\"}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: ":\"a.txt\"}" }]);
  });

  test("ignores local MCP tool-call updates and rejects unknown synthetic tools", () => {
    const local = createCursorProtobufEventState();
    const localCall = create(ToolCallSchema, {
      tool: {
        case: "mcpToolCall",
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, {
            name: "local",
            toolName: "local",
            toolCallId: "call_local",
            providerIdentifier: "opencodex",
          }),
        }),
      },
    });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_local", modelCallId: "model_1", toolCall: localCall }),
    }), local)).toEqual([]);

    const guarded = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__write_file", {}) }),
    }), guarded)).toEqual([{ type: "error", message: "Cursor requested unknown Responses tool: mcp__fs__write_file" }]);
  });

  test("rejects a second synthetic tool call when parallel tool calls are disabled", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"],
      parallelToolCalls: false,
    });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}) }),
    }), state)).toEqual([{ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}), argsTextDelta: "{}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: "{}" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: mcpToolCall("mcp__fs__write_file", {}) }),
    }), state)).toEqual([{ type: "error", message: "Cursor requested multiple parallel Responses tool calls but parallel_tool_calls is false" }]);
  });

  test("uses completed MCP args when no partial args arrived", () => {
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("trusts already-streamed JSON args and ignores the redundant completed map", () => {
    // Cursor streams the model's raw cumulative JSON text (with spaces), then redelivers the same
    // args as a structured map on completion. The streamed text is authoritative once it parses,
    // so completion must not re-append the compact map serialization (which would corrupt the
    // concatenated argument string the bridge rebuilds).
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" }]);

    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\": \"a.txt\"}" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: "{\"path\": \"a.txt\"}" }]);

    // Completion carries the same args as a map; no extra delta, no non-prefix error.
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([{ type: "tool_call_end", id: "call_1" }]);
  });

  test("falls back to the completed map when the streamed args never completed", () => {
    // A partial stream that stops mid-JSON (never a complete document) must be repaired from the
    // authoritative completed map instead of being dropped with a non-prefix error.
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });

    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"path\":" }),
    }), state)).toEqual([{ type: "tool_call_delta", arguments: "{\"path\":" }]);

    const completedEvents = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    // No error is emitted, and the call ends.
    expect(completedEvents.find(e => e.type === "error")).toBeUndefined();
    expect(completedEvents.at(-1)).toEqual({ type: "tool_call_end", id: "call_1" });
    // The full concatenated delta stream parses to the authoritative args.
    const streamed = [
      "{\"path\":",
      ...completedEvents.filter(e => e.type === "tool_call_delta").map(e => e.type === "tool_call_delta" ? e.arguments : ""),
    ].join("");
    expect(JSON.parse(streamed)).toEqual({ path: "a.txt" });
  });

  test("commits an advertised no-arg tool call instead of dropping it", () => {
    // A completed client tool call with no args and no streamed text must still reach Codex when the
    // tool is advertised (e.g. a no-arg list/status tool). The bridge serializes empty args as "{}".
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__list_roots"] });
    const toolCall = mcpToolCall("mcp__fs__list_roots", {});
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__list_roots" },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("does not commit a no-arg completion for an unadvertised tool (prelude noise)", () => {
    // Without an advertised client-tool list we cannot distinguish a real no-arg call from a Cursor
    // prelude, so an empty completion stays dropped.
    const state = createCursorProtobufEventState();
    const toolCall = mcpToolCall("mcp__fs__list_roots", {});
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([]);
  });

  test("fails closed when Cursor opens overlapping tool calls", () => {
    // call_1 is started and still open (not completed) when call_2 starts -> genuine overlap.
    // Cursor deltas carry no call id, so interleaving would cross-wire args; we reject instead.
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"] });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}) }),
    }), state)).toEqual([{ type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" }]);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: mcpToolCall("mcp__fs__write_file", {}) }),
    }), state)).toEqual([{ type: "error", message: "Cursor opened overlapping Responses tool calls; opencodex serializes Cursor tool calls and cannot interleave their arguments" }]);
  });

  test("allows sequential tool calls (no false-positive overlap)", () => {
    // call_1 completes before call_2 starts -> not an overlap. Both must succeed.
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file", "mcp__fs__write_file"] });
    const first = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: first }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "mcp__fs__read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end", id: "call_1" },
    ]);
    const second = mcpToolCall("mcp__fs__write_file", { path: "b.txt" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_2", modelCallId: "model_2", toolCall: second }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_2", name: "mcp__fs__write_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"b.txt\"}" },
      { type: "tool_call_end", id: "call_2" },
    ]);
  });

  test("turnEnded with an open tool call emits truncation error instead of done (fail-closed)", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    // Start a tool call but never complete it.
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall: mcpToolCall("mcp__fs__read_file", {}) }),
    }), state);
    // Now the turn ends while the tool call is still open.
    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });
    const events = mapCursorProtobufServerMessage(turnEnd, state);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("incomplete tool call");
    expect((events[0] as { message: string }).message).toContain("call_1");
  });

  test("turnEnded without open tool calls emits done normally", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    const toolCall = mcpToolCall("mcp__fs__read_file", { path: "a.txt" });
    // Complete the tool call first.
    mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state);
    // Turn ends cleanly.
    const turnEnd = create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }) },
    });
    const events = mapCursorProtobufServerMessage(turnEnd, state);
    expect(events).toEqual([{ type: "done", usage: { inputTokens: 0, outputTokens: 0, estimated: true } }]);
  });
});
