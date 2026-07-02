import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv, storeCursorBlob } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  expect(reply.message.case).toBe("kvClientMessage");
  const kv = reply.message.value;
  expect(kv.message.case).toBe("getBlobResult");
  return kv.message.value.blobData;
}

function decodeRootMessages(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return (run?.conversationState?.rootPromptMessagesJson ?? [])
    .map(blobId => JSON.parse(new TextDecoder().decode(blobData(blobId))) as unknown);
}

function actionText(bytes: Uint8Array): string | undefined {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const action = run?.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined;
}

describe("Cursor blob handshake", () => {
  test("storeCursorBlob returns the SHA-256 blob id (32 bytes)", () => {
    const data = new TextEncoder().encode('{"role":"system","content":"hi"}');
    const id = storeCursorBlob(data);
    expect(id.length).toBe(32);
    expect(Array.from(id)).toEqual(Array.from(sha256(data)));
  });

  test("encodeCursorRunRequest sends rootPromptMessagesJson as blob IDs, not inline JSON", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} }],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const roots = run?.conversationState?.rootPromptMessagesJson ?? [];

    expect(roots.length).toBeGreaterThan(0);
    // Every entry must be a 32-byte SHA-256 blob id (the bug was sending inline JSON → "Blob not found").
    for (const entry of roots) expect(entry.length).toBe(32);
    // The first root is the blob id of the system-prompt JSON exactly.
    const sysJson = new TextEncoder().encode(JSON.stringify({ role: "system", content: "You are helpful." }));
    expect(Array.from(roots[0]!)).toEqual(Array.from(sha256(sysJson)));
    // Client Responses tools are intentionally advertised via native exec RequestContext.tools,
    // not mirrored into the initial AgentRunRequest.mcp_tools payload. The top-level field is
    // not wire-compatible with the live Cursor Connect parser for this client path.
    expect(run?.mcpTools).toBeUndefined();
  });

  test("adds Cursor exact-tool guidance to system prompt blobs when tools are advertised", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "read a file" }],
      toolChoice: { mode: "required", allowedTools: ["read_file"] },
      tools: [
        { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
        { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
      ],
    });

    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `mcp__fs__read_file`");
    expect(roots).not.toContain("`mcp__fs__write_file`");
    expect(roots).toContain("neighboring-agent tool names `Read`, `Grep`, `Glob`, `Bash`, `LS`");
    expect(roots).toContain("unless a tool result was actually returned");

  });

  test("adds exec_command prompt hints for active shell requests when native exec is available", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "Run: echo OCX via your shell tool, report stdout." }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    });

    const roots = decodeRootMessages(bytes);
    expect(JSON.stringify(roots)).toContain("Shell commands use");
    expect(JSON.stringify(roots)).toContain("exec_command");
    expect(actionText(bytes)).toContain("Run: echo OCX via your shell tool, report stdout.");
    expect(actionText(bytes)).toContain("Use exec_command for this shell command.");
  });

  test("adds generic exec_command guidance for active tool-count demo prompts", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "developer", content: "아무 tool 10개 써봐" }],
      tools: [
        {
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
        { name: "tool_search", description: "Discover tools", parameters: {} },
      ],
    });

    const text = actionText(bytes);
    expect(text).toContain("아무 tool 10개 써봐");
    expect(text).toContain("This turn requests 10 tool uses");
    expect(text).toContain("exactly 10 separate `exec_command` function calls/results");
    expect(text).toContain("One `exec_command` containing chained commands counts as 1 tool call, not 10");
    expect(text).toContain("one parallel tool-call batch containing all 10");
    expect(text).toContain("repeated `exec_command` calls");
    expect(text).toContain("Codex Responses bridge exec tool");
    expect(text).toContain("external MCP server tool");
    expect(text).toContain("bridge may suspend");
    expect(text).toContain("Do not use `run_shell`");
    expect(text).toContain("Do not use `tool_search`, external MCP, or resource discovery just to pad the count");
    expect(text).toContain("neighboring-agent tools");
    expect(text).toContain("unless this turn's catalog lists those exact names");
    expect(text).not.toContain("Use exec_command for this shell command.");
    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `exec_command`");
    expect(roots).not.toContain("available tool names are exactly `exec_command`, `tool_search`");
  });

  test("keeps generic exec-only guidance on tool-result continuations", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: exec_command\nis_error: false\noutput:\ntool 1" }],
      rawMessages: [
        { role: "user", content: "tool use 10개해봐", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/composer-2.5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: { cmd: "echo tool 1" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "tool 1", isError: false, timestamp: 3 },
      ],
      tools: [
        { name: "exec_command", description: "Run", parameters: {} },
        { name: "tool_search", description: "Discover", parameters: {} },
      ],
    });

    const roots = JSON.stringify(decodeRootMessages(bytes));
    expect(roots).toContain("available tool names are exactly `exec_command`");
    expect(roots).not.toContain("available tool names are exactly `exec_command`, `tool_search`");
  });

  test("does not add exec_command to non-command active user text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-sonnet",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "user", content: "Tell me a short story about proxies." }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    });

    expect(actionText(bytes)).toBe("Tell me a short story about proxies.");
  });

  test("encodeCursorRunRequest surfaces trailing tool result as current action text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [
        { role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const action = run?.action?.action;

    expect(action?.case).toBe("userMessageAction");
    if (action?.case === "userMessageAction") {
      expect(action.value.userMessage?.text).toContain("[tool_result]");
      expect(action.value.userMessage?.text).toContain("call_id: call_1");
    }
  });

  test("encodeCursorRunRequest preserves prior assistant tool calls with tool results in turn steps", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "claude-4.6-opus-high",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: read_file\nis_error: false\noutput:\ncontents" }],
      rawMessages: [
        { role: "user", content: "read a file", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "contents", isError: false, timestamp: 3 },
      ],
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    const turnIds = run?.conversationState?.turns ?? [];
    expect(turnIds).toHaveLength(1);
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnIds[0]!));
    expect(turn.turn.case).toBe("agentConversationTurn");
    const steps = turn.turn.value.steps;
    expect(steps).toHaveLength(1);
    const step = fromBinary(ConversationStepSchema, blobData(steps[0]!));
    expect(step.message.case).toBe("toolCall");
    const tool = step.message.value.tool;
    expect(tool.case).toBe("mcpToolCall");
    if (tool.case === "mcpToolCall") {
      expect(tool.value.args?.toolCallId).toBe("call_1");
      expect(tool.value.result?.result.case).toBe("success");
      if (tool.value.result?.result.case === "success") {
        const content = tool.value.result.result.value.content[0]?.content;
        expect(content?.case).toBe("text");
        if (content?.case === "text") expect(content.value.text).toBe("contents");
      }
    }
    // The last raw message is a toolResult, so the turn continues the same Cursor conversation with
    // the tool result carried as structured history (mcpToolCall.result above). The action must be
    // ResumeAction, NOT a UserMessageAction that would re-inject the tool result as user text.
    expect(run?.action?.action.case).toBe("resumeAction");
  });
});
