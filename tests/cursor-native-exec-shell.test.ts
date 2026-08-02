import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  ShellArgsSchema,
  type AgentClientMessage,
} from "../src/adapters/cursor/gen/agent_pb";
import { shellStreamExec } from "../src/adapters/cursor/native-exec-shell";

function decodeClient(bytes: Uint8Array): AgentClientMessage {
  return fromBinary(AgentClientMessageSchema, bytes);
}

describe("shellStreamExec completion acknowledgement", () => {
  test("appends structured shellResult and streamClose after the exit event", async () => {
    const execMsg = create(ExecServerMessageSchema, {
      id: 42,
      execId: "7",
      message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "echo OCX_STREAM_OK" }) },
    });

    const replies = (await shellStreamExec(execMsg)).map(decodeClient);
    const execMessages = replies.filter(r => r.message.case === "execClientMessage");
    const cases = execMessages.map(r => (r.message.case === "execClientMessage" ? r.message.value.message.case : undefined));

    // Stream events precede the structured result: start ... stdout ... exit, then shellResult.
    expect(cases[0]).toBe("shellStream");
    expect(cases.at(-1)).toBe("shellResult");

    const shellResult = execMessages.at(-1);
    if (shellResult?.message.case !== "execClientMessage") throw new Error("missing exec client message");
    expect(shellResult.message.value.id).toBe(42);
    expect(shellResult.message.value.execId).toBe("7");
    const resultMsg = shellResult.message.value.message;
    if (resultMsg.case !== "shellResult") throw new Error("missing shellResult");
    expect(resultMsg.value.result.case).toBe("success");
    if (resultMsg.value.result.case === "success") {
      expect(resultMsg.value.result.value.stdout).toContain("OCX_STREAM_OK");
      expect(resultMsg.value.result.value.exitCode).toBe(0);
    }

    // The very last frame closes the exec stream (Cursor treats deltas/exit alone as still-pending).
    const last = replies.at(-1);
    expect(last?.message.case).toBe("execClientControlMessage");
    if (last?.message.case === "execClientControlMessage") {
      expect(last.message.value.message.case).toBe("streamClose");
      if (last.message.value.message.case === "streamClose") {
        expect(last.message.value.message.value.id).toBe(42);
      }
    }
  });

  test("failure path still sends shellResult failure and streamClose", async () => {
    const execMsg = create(ExecServerMessageSchema, {
      id: 9,
      execId: "3",
      message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "exit 3" }) },
    });
    const replies = (await shellStreamExec(execMsg)).map(decodeClient);
    const shellResult = replies.filter(r => r.message.case === "execClientMessage").at(-1);
    if (shellResult?.message.case !== "execClientMessage" || shellResult.message.value.message.case !== "shellResult") {
      throw new Error("missing shellResult");
    }
    expect(shellResult.message.value.message.value.result.case).toBe("failure");
    expect(replies.at(-1)?.message.case).toBe("execClientControlMessage");
  });
});
