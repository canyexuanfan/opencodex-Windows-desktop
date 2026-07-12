/**
 * Claude Code outbound: internal /v1/responses output -> Anthropic Messages API shapes.
 *
 * Wire contract pinned in devlog/260711_claude_inbound/003_evidence.md (all Tier 2):
 *  - SSE order: message_start -> (content_block_start -> deltas -> content_block_stop)*
 *    -> message_delta -> message_stop; any number of `ping`.
 *  - thinking blocks get thinking_delta(s) then ONE synthetic signature_delta just
 *    before content_block_stop (CCR precedent: Claude Code does not verify signatures).
 *  - message_delta.usage is cumulative; message_start embeds a full message snapshot.
 *  - errors: {type:"error", error:{type,message}}; may arrive mid-stream after HTTP 200.
 */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** HTTP status -> Anthropic error taxonomy (010 amendment #4; full official table per devlog 100). */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 402: return "billing_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 409: return "conflict_error";
    case 413: return "request_too_large";
    case 429: return "rate_limit_error";
    case 504: return "timeout_error";
    case 529: return "overloaded_error";
    default: return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function anthropicErrorBody(status: number, message: string, type?: string): Rec {
  return { type: "error", error: { type: type ?? anthropicErrorType(status), message } };
}

export function anthropicErrorResponse(status: number, message: string, type?: string): Response {
  return new Response(JSON.stringify(anthropicErrorBody(status, message, type)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Responses usage -> Anthropic usage. Responses `input_tokens` is INCLUSIVE of cache
 * read+write (types.ts convention); Anthropic `input_tokens` excludes both, so
 * subtract the full cache detail (devlog 070 — subtracting reads only inflated the
 * non-cached input Claude Code displays by the write share).
 */
export function anthropicUsage(usage: unknown): Rec {
  const u = isRec(usage) ? usage : {};
  const details = isRec(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const cacheWrite = typeof details.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return {
    input_tokens: Math.max(0, input - cached - cacheWrite),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
  };
}

function sseFrame(name: string, data: Rec): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageSnapshot(model: string): Rec {
  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: [],
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

interface OpenBlock {
  kind: "text" | "thinking" | "tool_use";
  index: number;
  /** Responses item_id (tool calls) so output_item.done can match. */
  itemId?: string;
}

/** Streaming: Responses SSE bytes -> Anthropic Messages SSE bytes. */
export function responsesSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  opts?: { pingIntervalMs?: number },
): ReadableStream<Uint8Array> {
  const pingIntervalMs = opts?.pingIntervalMs ?? 20_000;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let started = false;
  let terminated = false;
  let cancelled = false;
  let blockIndex = 0;
  let open: OpenBlock | null = null;
  let sawToolUse = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (name: string, data: Rec) => controller.enqueue(encoder.encode(sseFrame(name, data)));
      const ensureStarted = () => {
        if (started) return;
        started = true;
        emit("message_start", { type: "message_start", message: messageSnapshot(model) });
        emit("ping", { type: "ping" });
      };
      // Idle keepalive (devlog 100): real Anthropic streams may interleave pings anywhere;
      // synthesizing one during upstream silence protects remote deployments behind
      // LB/NAT idle timeouts and covers slow first tokens. Cheap and spec-legal.
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          if (terminated) return;
          try {
            ensureStarted();
            emit("ping", { type: "ping" });
          } catch { /* controller torn down; the read loop is ending anyway */ }
        }, pingIntervalMs);
      }
      const closeOpenBlock = () => {
        if (!open) return;
        if (open.kind === "thinking") {
          // Synthetic signature: Claude Code accepts it (003 E6); inbound drops replays anyway.
          emit("content_block_delta", {
            type: "content_block_delta", index: open.index,
            delta: { type: "signature_delta", signature: `ocx${Date.now()}` },
          });
        }
        emit("content_block_stop", { type: "content_block_stop", index: open.index });
        open = null;
      };
      const ensureBlock = (kind: "text" | "thinking") => {
        ensureStarted();
        if (open && open.kind === kind) return;
        closeOpenBlock();
        const index = blockIndex++;
        const contentBlock: Rec = kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "", signature: "" };
        emit("content_block_start", { type: "content_block_start", index, content_block: contentBlock });
        open = { kind, index };
      };
      const finish = (stopReason: string, usage: unknown) => {
        if (terminated) return;
        terminated = true;
        ensureStarted();
        closeOpenBlock();
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: anthropicUsage(usage),
        });
        emit("message_stop", { type: "message_stop" });
      };
      const fail = (status: number, message: string) => {
        if (terminated) return;
        terminated = true;
        ensureStarted();
        closeOpenBlock();
        emit("error", anthropicErrorBody(status, message));
      };

      const handleFrame = (eventName: string, data: Rec) => {
        switch (eventName) {
          case "response.created":
            ensureStarted();
            break;
          case "response.heartbeat":
            ensureStarted();
            emit("ping", { type: "ping" });
            break;
          case "response.output_text.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            ensureBlock("text");
            emit("content_block_delta", {
              type: "content_block_delta", index: open!.index,
              delta: { type: "text_delta", text: data.delta },
            });
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            ensureBlock("thinking");
            emit("content_block_delta", {
              type: "content_block_delta", index: open!.index,
              delta: { type: "thinking_delta", thinking: data.delta },
            });
            break;
          }
          case "response.output_item.added": {
            const item = isRec(data.item) ? data.item : null;
            if (!item || item.type !== "function_call") break;
            ensureStarted();
            closeOpenBlock();
            sawToolUse = true;
            const index = blockIndex++;
            emit("content_block_start", {
              type: "content_block_start", index,
              content_block: {
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : `toolu_${uuid()}`,
                name: typeof item.name === "string" ? item.name : "",
                input: {},
              },
            });
            open = { kind: "tool_use", index, itemId: typeof item.id === "string" ? item.id : undefined };
            break;
          }
          case "response.function_call_arguments.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            if (!open || open.kind !== "tool_use") break;
            emit("content_block_delta", {
              type: "content_block_delta", index: open.index,
              delta: { type: "input_json_delta", partial_json: data.delta },
            });
            break;
          }
          case "response.output_item.done": {
            const item = isRec(data.item) ? data.item : null;
            if (!open || !item) break;
            // Close the matching open block (message/reasoning items close implicitly on
            // the next block; function_call items must close here so tool input parses).
            if (open.kind === "tool_use" && item.type === "function_call") closeOpenBlock();
            else if (open.kind === "text" && item.type === "message") closeOpenBlock();
            else if (open.kind === "thinking" && item.type === "reasoning") closeOpenBlock();
            break;
          }
          case "response.completed": {
            const response = isRec(data.response) ? data.response : {};
            finish(sawToolUse ? "tool_use" : "end_turn", response.usage);
            break;
          }
          case "response.incomplete": {
            const response = isRec(data.response) ? data.response : {};
            const details = isRec(response.incomplete_details) ? response.incomplete_details : {};
            const reason = details.reason === "max_output_tokens" ? "max_tokens"
              : details.reason === "content_filter" ? "refusal"
              : sawToolUse ? "tool_use" : "end_turn";
            finish(reason, response.usage);
            break;
          }
          case "response.failed": {
            const response = isRec(data.response) ? data.response : {};
            const error = isRec(response.error) ? response.error : {};
            const message = typeof error.message === "string" ? error.message : "upstream request failed";
            const status = typeof error.status === "number" ? error.status : 500;
            fail(status, message);
            break;
          }
          default:
            break; // web_search_call / custom_tool_call / content_part frames: ignored v1
        }
      };

      reader = upstream.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const rawFrame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              let eventName = "";
              let dataLine = "";
              for (const line of rawFrame.split("\n")) {
                if (line.startsWith("event: ")) eventName = line.slice(7).trim();
                else if (line.startsWith("data: ")) dataLine += line.slice(6);
              }
              if (!eventName || !dataLine) continue;
              let data: unknown;
              try { data = JSON.parse(dataLine); } catch { continue; }
              if (!isRec(data)) continue;
              if (terminated) continue;
              handleFrame(eventName, data);
            }
          }
          // EOF without a terminal frame is a TRUNCATION, not success (devlog 100:
          // gateways that close such streams politely hand Claude Code an empty/partial
          // turn with no retryable error — CLIProxyAPI#2189 failure pattern). Fail closed
          // with a mid-stream Anthropic error event so the client can retry.
          if (!cancelled) fail(502, "upstream stream ended before a terminal frame (truncated response)");
        } catch (err) {
          fail(500, err instanceof Error ? err.message : String(err));
        } finally {
          if (pingTimer !== undefined) clearInterval(pingTimer);
          reader.releaseLock();
          if (!cancelled) controller.close();
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      if (pingTimer !== undefined) clearInterval(pingTimer);
      return reader?.cancel(reason);
    },
  });
}

/** Non-streaming: /v1/responses JSON -> Anthropic message JSON. */
export function responsesJsonToAnthropicMessage(json: unknown, model: string): Rec {
  const body = isRec(json) ? json : {};
  const output = Array.isArray(body.output) ? body.output : [];
  const content: Rec[] = [];
  let sawToolUse = false;

  for (const raw of output) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "message": {
        if (!Array.isArray(raw.content)) break;
        for (const part of raw.content) {
          if (isRec(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0) {
            content.push({ type: "text", text: part.text });
          }
        }
        break;
      }
      case "reasoning": {
        const parts: string[] = [];
        if (Array.isArray(raw.summary)) {
          for (const s of raw.summary) {
            if (isRec(s) && typeof s.text === "string" && s.text.length > 0) parts.push(s.text);
          }
        }
        if (Array.isArray(raw.content)) {
          for (const s of raw.content) {
            if (isRec(s) && typeof s.text === "string" && s.text.length > 0) parts.push(s.text);
          }
        }
        if (parts.length > 0) {
          content.push({ type: "thinking", thinking: parts.join("\n\n"), signature: `ocx${Date.now()}` });
        }
        break;
      }
      case "function_call": {
        sawToolUse = true;
        let input: unknown = {};
        if (typeof raw.arguments === "string" && raw.arguments.length > 0) {
          try { input = JSON.parse(raw.arguments); } catch { input = {}; }
        }
        content.push({
          type: "tool_use",
          id: typeof raw.call_id === "string" ? raw.call_id : `toolu_${uuid()}`,
          name: typeof raw.name === "string" ? raw.name : "",
          input,
        });
        break;
      }
      default:
        break;
    }
  }

  const details = isRec(body.incomplete_details) ? body.incomplete_details : {};
  const stopReason = body.status === "incomplete" && details.reason === "max_output_tokens"
    ? "max_tokens"
    : sawToolUse ? "tool_use" : "end_turn";

  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage(body.usage),
  };
}

/**
 * Fold an Anthropic SSE stream (our own emission vocabulary) into a message JSON.
 * Used for non-streaming client requests: the internal replay always streams
 * (routed adapters do not support non-stream turns), so the translated stream is
 * aggregated here instead of translating a JSON body.
 */
export async function collectAnthropicMessage(stream: ReadableStream<Uint8Array>, model: string): Promise<Rec> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  const content: Rec[] = [];
  let openBlock: Rec | null = null;
  let toolJson = "";
  let stopReason: string | null = "end_turn";
  let usage: Rec = anthropicUsage(undefined);
  let error: Rec | null = null;

  const closeBlock = () => {
    if (!openBlock) return;
    if (openBlock.type === "tool_use") {
      try { openBlock.input = toolJson.length > 0 ? JSON.parse(toolJson) : {}; } catch { openBlock.input = {}; }
    }
    content.push(openBlock);
    openBlock = null;
    toolJson = "";
  };

  const handle = (name: string, data: Rec) => {
    switch (name) {
      case "content_block_start":
        closeBlock();
        if (isRec(data.content_block)) openBlock = { ...data.content_block };
        break;
      case "content_block_delta": {
        const delta = isRec(data.delta) ? data.delta : {};
        if (!openBlock) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          openBlock.text = `${openBlock.text ?? ""}${delta.text}`;
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          openBlock.thinking = `${openBlock.thinking ?? ""}${delta.thinking}`;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          openBlock.signature = delta.signature;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          toolJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop":
        closeBlock();
        break;
      case "message_delta": {
        const delta = isRec(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        if (isRec(data.usage)) usage = data.usage;
        break;
      }
      case "error":
        error = data;
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventName = "";
        let dataLine = "";
        for (const line of rawFrame.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine += line.slice(6);
        }
        if (!eventName || !dataLine) continue;
        let data: unknown;
        try { data = JSON.parse(dataLine); } catch { continue; }
        if (isRec(data)) handle(eventName, data);
      }
    }
  } finally {
    reader.releaseLock();
  }
  closeBlock();

  if (error) return error;
  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
