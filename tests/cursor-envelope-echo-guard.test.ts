import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { create } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { CURSOR_TOOL_RESULT_ENVELOPE_GUARD_NOTE } from "../src/adapters/cursor/tool-definitions";
import type { OcxMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage" || reply.message.value.message.case !== "getBlobResult") {
    throw new Error("expected getBlobResult");
  }
  return reply.message.value.message.value.blobData!;
}

function rootTexts(bytes: Uint8Array): string[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  return (run?.conversationState?.rootPromptMessagesJson ?? []).map(blobId => {
    const parsed = JSON.parse(new TextDecoder().decode(blobData(blobId))) as { content?: [{ text?: string }] };
    return parsed.content?.[0]?.text ?? "";
  });
}

function toolRoundHistory(): OcxMessage[] {
  return [
    { role: "user", content: "run the probe", timestamp: 1 },
    { role: "assistant", content: "Running it now.", timestamp: 2 } as OcxMessage,
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "run_cmd",
      content: "R1=A17",
      isError: false,
      timestamp: 3,
    } as OcxMessage,
    { role: "user", content: "continue", timestamp: 4 },
  ];
}

function encode(messages: OcxMessage[], modelId = "kimi-k3") {
  return encodeCursorRunRequest({
    modelId,
    conversationId: "c_echo",
    system: [],
    messages: [],
    rawMessages: messages,
  });
}

describe("cursor external-replay envelope echo guard (devlog 260826 gap-10)", () => {
  test("external replay with a tool result appends the envelope guard note once", () => {
    const texts = rootTexts(encode(toolRoundHistory()));
    const guards = texts.filter(text => text === CURSOR_TOOL_RESULT_ENVELOPE_GUARD_NOTE);
    expect(guards).toHaveLength(1);
    // The guard must come after the replayed [Tool Result] entry it explains.
    const toolIdx = texts.findIndex(text => text.startsWith("[Tool Result]"));
    const guardIdx = texts.indexOf(CURSOR_TOOL_RESULT_ENVELOPE_GUARD_NOTE);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(toolIdx);
  });

  test("external replay without tool results emits no guard note", () => {
    const texts = rootTexts(encode([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi", timestamp: 2 } as OcxMessage,
      { role: "user", content: "continue", timestamp: 3 },
    ]));
    expect(texts).not.toContain(CURSOR_TOOL_RESULT_ENVELOPE_GUARD_NOTE);
  });
});
