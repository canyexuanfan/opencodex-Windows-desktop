import type { OcxUsage } from "../../types";
import type { AgentServerMessage, McpArgs, ToolCall } from "./gen/agent_pb";
import { decodeCursorArgsMap } from "./arg-codec";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
import type { CursorServerMessage } from "./types";

export interface CursorProtobufEventState {
  usage: OcxUsage;
  openToolCalls: Map<string, { name: string; args: string }>;
  completedToolCalls: Set<string>;
  clientToolNames?: Set<string>;
  parallelToolCalls?: boolean;
  startedClientToolCalls: number;
}

export function createCursorProtobufEventState(options: { clientToolNames?: Iterable<string>; parallelToolCalls?: boolean } = {}): CursorProtobufEventState {
  return {
    // Cursor provides no authoritative usage frame; token counts are heuristic estimates from
    // checkpoint/delta events, so mark estimated from the start.
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    openToolCalls: new Map(),
    completedToolCalls: new Set(),
    ...(options.clientToolNames ? { clientToolNames: new Set(options.clientToolNames) } : {}),
    ...(options.parallelToolCalls !== undefined ? { parallelToolCalls: options.parallelToolCalls } : {}),
    startedClientToolCalls: 0,
  };
}

function mcpArgsFromToolCall(toolCall: ToolCall | undefined): McpArgs | undefined {
  if (toolCall?.tool.case !== "mcpToolCall") return undefined;
  const args = toolCall.tool.value.args;
  return args?.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER ? args : undefined;
}

function mcpToolName(toolCall: ToolCall | undefined): string | undefined {
  const args = mcpArgsFromToolCall(toolCall);
  const name = args?.toolName || args?.name;
  return name && name.length > 0 ? name : undefined;
}

function decodeMcpArgs(args: McpArgs | undefined): string {
  return JSON.stringify(decodeCursorArgsMap(args?.args));
}

function hasMcpArgBytes(args: McpArgs | undefined): boolean {
  return Object.keys(args?.args ?? {}).length > 0;
}

function isCompleteJson(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile a completed Responses tool call against whatever args were already streamed.
 *
 * Cursor streams `argsTextDelta` as the model emits it (arbitrary whitespace / key order), then the
 * `toolCallCompleted` update redelivers the same args as a structured protobuf map. Our bridge
 * rebuilds the final argument string by concatenating the `tool_call_delta` chunks we emit, so the
 * streamed text and a freshly serialized map only have to *agree*, not match byte-for-byte. When the
 * streamed text already parses as JSON it is authoritative; re-appending the compact map
 * serialization would corrupt the concatenated string (e.g. `{"path": "a.txt"}` + `{"path":"a.txt"}`).
 */
function reconcileCompletedArgs(
  state: CursorProtobufEventState,
  callId: string,
  streamed: string,
  args: McpArgs | undefined,
): CursorServerMessage[] {
  // Streamed text is already a complete JSON document: it is authoritative. Re-appending the
  // compact map serialization would corrupt the concatenated argument string the bridge rebuilds.
  if (isCompleteJson(streamed)) return [];
  // Otherwise fall back to the structured map. An incomplete stream is always a true prefix of the
  // final document, so appendToolArgs forwards only the missing remainder. If the bytes genuinely
  // diverged (a corrupt stream we can no longer un-send), appendToolArgs surfaces an honest error
  // instead of silently shipping broken args.
  if (!hasMcpArgBytes(args)) return [];
  return appendToolArgs(state, callId, decodeMcpArgs(args));
}

export function mapSyntheticMcpExecToToolEvents(
  args: McpArgs,
  fallbackCallId = "cursor_mcp_exec",
  options: { allowEmptyArgs?: boolean; suppressStart?: boolean; state?: CursorProtobufEventState } = {},
): CursorServerMessage[] {
  if (args.providerIdentifier !== OCX_RESPONSES_TOOL_PROVIDER) return [];
  if (options.allowEmptyArgs !== true && !hasMcpArgBytes(args)) return [];
  const name = args.toolName || args.name;
  if (!name) return [{ type: "error", message: "Cursor requested a Responses tool without a tool name" }];
  const callId = args.toolCallId || fallbackCallId;
  if (options.state?.completedToolCalls.has(callId)) return [];
  if (options.state) {
    const out: CursorServerMessage[] = [];
    if (options.suppressStart !== true) out.push(...startToolCall(options.state, callId, name));
    if (out.some(event => event.type === "error")) return out;
    const open = options.state.openToolCalls.get(callId);
    out.push(...reconcileCompletedArgs(options.state, callId, open?.args ?? "", args));
    out.push(...endToolCall(options.state, callId));
    return out;
  }
  const out: CursorServerMessage[] = [];
  if (options.suppressStart !== true) out.push({ type: "tool_call_start", id: callId, name });
  out.push({ type: "tool_call_delta", arguments: decodeMcpArgs(args) });
  out.push({ type: "tool_call_end", id: callId });
  return out;
}

function startToolCall(state: CursorProtobufEventState, callId: string, name: string): CursorServerMessage[] {
  if (state.completedToolCalls.has(callId)) return [];
  if (state.openToolCalls.has(callId)) return [];
  if (state.clientToolNames && !state.clientToolNames.has(name)) {
    return [{ type: "error", message: `Cursor requested unknown Responses tool: ${name}` }];
  }
  if (state.parallelToolCalls === false && state.startedClientToolCalls > 0) {
    return [{ type: "error", message: "Cursor requested multiple parallel Responses tool calls but parallel_tool_calls is false" }];
  }
  // Fail closed on genuine overlap: a different client tool call is already open and uncompleted.
  // Cursor's downstream tool_call_delta/end events carry no call id and the Responses bridge tracks
  // a single current tool call, so interleaving two open calls would cross-wire their arguments.
  // (`startedClientToolCalls` is never decremented, so it cannot distinguish overlap from sequential
  // calls — overlap must be detected from the live `openToolCalls` set. The explicit
  // parallel_tool_calls=false rejection above takes precedence when configured.)
  if (state.openToolCalls.size > 0) {
    return [{ type: "error", message: "Cursor opened overlapping Responses tool calls; opencodex serializes Cursor tool calls and cannot interleave their arguments" }];
  }
  state.openToolCalls.set(callId, { name, args: "" });
  state.startedClientToolCalls++;
  return [{ type: "tool_call_start", id: callId, name }];
}

function appendToolArgs(state: CursorProtobufEventState, callId: string, nextArgs: string): CursorServerMessage[] {
  if (nextArgs.length === 0) return [];
  const open = state.openToolCalls.get(callId);
  const delta = open ? nextArgs.slice(open.args.length) : nextArgs;
  if (open) {
    if (!nextArgs.startsWith(open.args)) {
      // Streaming chunks are cumulative, so a non-prefix here means a genuinely corrupt stream.
      state.openToolCalls.delete(callId);
      return [{ type: "error", message: `Cursor sent non-prefix Responses tool arguments for call ${callId}` }];
    }
    open.args = nextArgs;
  }
  if (delta.length === 0) return [];
  return [{ type: "tool_call_delta", arguments: delta }];
}

function endToolCall(state: CursorProtobufEventState, callId: string): CursorServerMessage[] {
  if (!state.openToolCalls.has(callId)) return [];
  state.openToolCalls.delete(callId);
  state.completedToolCalls.add(callId);
  return [{ type: "tool_call_end", id: callId }];
}

export function mapCursorProtobufServerMessage(
  serverMessage: AgentServerMessage,
  state: CursorProtobufEventState,
): CursorServerMessage[] {
  if (serverMessage.message.case === "conversationCheckpointUpdate") {
    const usedTokens = serverMessage.message.value.tokenDetails?.usedTokens ?? 0;
    if (usedTokens > state.usage.outputTokens) state.usage.outputTokens = usedTokens;
    return [];
  }

  if (serverMessage.message.case !== "interactionUpdate") return [];
  const update = serverMessage.message.value.message;
  switch (update.case) {
    case "textDelta":
      return update.value.text ? [{ type: "text", text: update.value.text }] : [];
    case "thinkingDelta":
      return update.value.text ? [{ type: "thinking", thinking: update.value.text }] : [];
    case "toolCallStarted": {
      const name = mcpToolName(update.value.toolCall);
      return name ? startToolCall(state, update.value.callId, name) : [];
    }
    case "partialToolCall": {
      const out: CursorServerMessage[] = [];
      const name = mcpToolName(update.value.toolCall);
      if (name) out.push(...startToolCall(state, update.value.callId, name));
      if (state.openToolCalls.has(update.value.callId)) {
        out.push(...appendToolArgs(state, update.value.callId, update.value.argsTextDelta));
      }
      return out;
    }
    case "toolCallDelta":
      // Cursor's typed deltas currently cover native exec internals (shell/task/edit). Client
      // Responses tools return as McpToolCall plus partial args text, so native deltas stay internal.
      return [];
    case "toolCallCompleted": {
      const out: CursorServerMessage[] = [];
      if (state.completedToolCalls.has(update.value.callId)) return [];
      const name = mcpToolName(update.value.toolCall);
      const args = mcpArgsFromToolCall(update.value.toolCall);
      const openBeforeStart = state.openToolCalls.get(update.value.callId);
      // Empty-arg completion handling:
      //  - already open with empty args  -> wait for the native-exec args path (do not commit yet).
      //  - never started + not advertised -> Cursor prelude noise, drop it.
      //  - advertised client tool, not yet open -> a legitimate no-arg call: commit it (start+end)
      //    so it is not silently dropped; the bridge serializes empty args as "{}".
      if (name && !hasMcpArgBytes(args)) {
        if (openBeforeStart && openBeforeStart.args.length === 0) return [];
        // Only commit a no-arg call when the tool is *explicitly* advertised. Without an advertised
        // tool list we cannot tell a real no-arg call from a Cursor prelude, so we keep dropping it.
        const advertised = state.clientToolNames?.has(name) ?? false;
        if (!openBeforeStart && !advertised) return [];
      }
      if (name) out.push(...startToolCall(state, update.value.callId, name));
      if (out.some(event => event.type === "error")) return out;
      const open = state.openToolCalls.get(update.value.callId);
      if (open) {
        out.push(...reconcileCompletedArgs(state, update.value.callId, open.args, args));
      }
      out.push(...endToolCall(state, update.value.callId));
      return out;
    }
    case "tokenDelta":
      state.usage.outputTokens += update.value.tokens;
      return [];
    case "turnEnded":
      return finalizeTurn(state);
    default:
      return [];
  }
}

/**
 * Finalize a Cursor turn. If any client tool call is still open (started but never completed),
 * the stream was truncated and the partial tool call must not reach Codex as a completed call
 * with corrupt/empty arguments. Emit an explicit error instead of done (fail-closed).
 * Mirrors kiro-truncation.ts behavior.
 */
function finalizeTurn(state: CursorProtobufEventState): CursorServerMessage[] {
  if (state.openToolCalls.size > 0) {
    const openIds = [...state.openToolCalls.keys()].join(", ");
    // Clear so a second turnEnded (should not happen, but defensive) doesn't re-emit.
    state.openToolCalls.clear();
    return [{ type: "error", message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.` }];
  }
  return [{ type: "done", usage: { ...state.usage } }];
}
