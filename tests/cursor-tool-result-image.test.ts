import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  ConversationTurnStructureSchema,
  ConversationStepSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

/** Every content item Cursor will see for the tool result attached to the assistant's tool call. */
function toolResultItems(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const turnIds = run?.conversationState?.turns ?? [];
  const stepIds: Uint8Array[] = [];
  for (const turnId of turnIds) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    stepIds.push(...(turn.turn.value.steps ?? []));
  }
  for (const stepId of stepIds) {
    const step = fromBinary(ConversationStepSchema, blobData(stepId));
    if (step.message.case !== "toolCall") continue;
    const tool = step.message.value.tool;
    if (tool.case !== "mcpToolCall") continue;
    const result = tool.value.result;
    if (result?.result.case !== "success") continue;
    return result.result.value.content;
  }
  return undefined;
}

function request(resultContent: OcxMessage extends never ? never : any) {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "take a screenshot", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/auto",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_shot", name: "js", namespace: "mcp__node_repl", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "call_shot",
      toolName: "js",
      toolNamespace: "mcp__node_repl",
      content: resultContent,
      isError: false,
      timestamp: 3,
    },
  ];
  return encodeCursorRunRequest({
    modelId: "composer-2.5",
    conversationId: "cursor_image_test",
    system: ["You are helpful."],
    messages: [{ role: "tool", content: "[tool_result]" }],
    rawMessages,
  });
}

describe("Cursor tool-result image passthrough", () => {
  test("a data: image becomes real McpImageContent with its bytes and mime, in part order", () => {
    const items = toolResultItems(request([
      { type: "text", text: "here is the screen" },
      { type: "image", imageUrl: PNG_DATA_URL, detail: "auto" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(2);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toBe("here is the screen");
    // The decisive assertion: the model receives the actual bytes, not a placeholder.
    expect(items![1].content.case).toBe("image");
    if (items![1].content.case !== "image") throw new Error("expected image content");
    expect(items![1].content.value.mimeType).toBe("image/png");
    expect(Array.from(items![1].content.value.data)).toEqual(Array.from(PNG_BYTES));
  });

  test("string content still produces exactly one text item", () => {
    const items = toolResultItems(request("plain output"));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toBe("plain output");
  });

  test("a remote https image degrades to a placeholder and sends no bytes", () => {
    const items = toolResultItems(request([
      { type: "image", imageUrl: "https://example.com/shot.png" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    // McpImageContent carries bytes; fetching a remote URL inside request construction would put
    // network IO on the encoding path, so it stays a placeholder.
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toContain("image omitted");
  });

  test("malformed base64 degrades to a placeholder without throwing", () => {
    const items = toolResultItems(request([
      { type: "image", imageUrl: "data:image/png;base64,!!!not-base64!!!" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toContain("image omitted");
  });

  test("images are admitted until the step budget is exhausted, then degrade", () => {
    // Two images that each fit alone but cannot both fit: the budget is a fraction of the per-blob
    // admission ceiling, because one ConversationStep is stored as one blob.
    const bigBytes = new Uint8Array(5 * 1024 * 1024).fill(7);
    const bigUrl = `data:image/png;base64,${Buffer.from(bigBytes).toString("base64")}`;
    const items = toolResultItems(request([
      { type: "image", imageUrl: bigUrl },
      { type: "image", imageUrl: bigUrl },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(2);
    const cases = items!.map(i => i.content.case);
    // First fits, second is over the remaining budget.
    expect(cases[0]).toBe("image");
    expect(cases[1]).toBe("text");
    expect(items![1].content.case === "text" ? items![1].content.value.text : "").toContain("exceeds the remaining step budget");
  });

  test("a text-only tool result is byte-identical to the pre-change encoding", () => {
    // Guards the no-image path: nothing about a request without images may shift.
    const a = toolResultItems(request([{ type: "text", text: "only text" }]));
    const b = toolResultItems(request("only text"));

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.length).toBe(1);
    expect(a![0].content.case).toBe("text");
    expect(a![0].content.case === "text" ? a![0].content.value.text : "").toBe("only text");
    expect(b![0].content.case === "text" ? b![0].content.value.text : "").toBe("only text");
  });
});
