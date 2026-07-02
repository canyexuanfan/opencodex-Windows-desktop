import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  type ExecClientMessage,
  type ExecServerMessage,
} from "./gen/agent_pb";

export const textDecoder = new TextDecoder();
export const textEncoder = new TextEncoder();

export function clientBytes(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message));
}

export function execBytes(execMsg: ExecServerMessage, messageCase: ExecClientMessage["message"]["case"], value: unknown): Uint8Array {
  return clientBytes({
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id: execMsg.id,
        execId: execMsg.execId,
        message: { case: messageCase, value: value as never },
      }),
    },
  });
}

/**
 * Exec-channel stream close acknowledgement (`execClientControlMessage.streamClose`). Cursor keeps
 * a streamed exec (e.g. `shellStreamArgs`) — and with it the whole turn — pending until the client
 * closes the exec stream; stream deltas and even the `exit` event alone are not treated as
 * completion. Mirrors jawcode `sendExecClientStreamClose`.
 */
export function execStreamCloseBytes(execMsg: ExecServerMessage): Uint8Array {
  return clientBytes({
    message: {
      case: "execClientControlMessage",
      value: create(ExecClientControlMessageSchema, {
        message: { case: "streamClose", value: create(ExecClientStreamCloseSchema, { id: execMsg.id }) },
      }),
    },
  });
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}
