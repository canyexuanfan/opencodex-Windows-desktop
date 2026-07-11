/**
 * Anthropic Messages inbound (/v1/messages + /v1/messages/count_tokens) for Claude Code.
 *
 * Translate-and-replay (devlog/260711_claude_inbound/010): the Anthropic request is
 * converted to a /v1/responses body and replayed through handleResponses on an
 * internal Request, so routing/OAuth/account-pool/failover/sidecars are inherited
 * unchanged. The Responses output (SSE or JSON) is converted back to Anthropic shape.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { AnthropicRequestError, anthropicToResponsesBody } from "../claude/inbound";
import {
  anthropicErrorBody,
  anthropicErrorResponse,
  collectAnthropicMessage,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
} from "../claude/outbound";
import { estimateTokens } from "../lib/token-estimate";
import type { OcxConfig } from "../types";
import { readJsonRequestBody } from "./request-decompress";
import type { RequestLogContext } from "./request-log";
import { handleResponses } from "./responses";

type Rec = Record<string, unknown>;

function claudeInboundDisabled(config: OcxConfig): Response | null {
  if (config.claudeCode?.enabled === false) {
    return anthropicErrorResponse(403, "Claude inbound is disabled (GUI: Claude ON toggle / config.claudeCode.enabled)", "permission_error");
  }
  return null;
}

async function readAnthropicBody(req: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(req);
  } catch (err) {
    throw new AnthropicRequestError(err instanceof Error && err.message ? err.message : "Invalid JSON body");
  }
}

export async function handleClaudeMessages(req: Request, config: OcxConfig, logCtx: RequestLogContext): Promise<Response> {
  const disabled = claudeInboundDisabled(config);
  if (disabled) return disabled;

  let anthropicBody: unknown;
  let internalBody: Rec;
  try {
    anthropicBody = await readAnthropicBody(req);
    internalBody = anthropicToResponsesBody(anthropicBody, config.claudeCode);
  } catch (err) {
    if (err instanceof AnthropicRequestError) return anthropicErrorResponse(400, err.message);
    return anthropicErrorResponse(500, err instanceof Error ? err.message : String(err));
  }

  const requestedModel = (anthropicBody as Rec).model as string;
  const stream = internalBody.stream === true;
  // Routed adapters only support streamed turns; always stream internally and fold
  // the translated Anthropic SSE into a message JSON for non-streaming clients.
  internalBody.stream = true;

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(internalBody),
  });

  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal });

  if (!response.ok) {
    // Re-shape the OpenAI-style error envelope into the Anthropic one, preserving status.
    let message = `upstream error (${response.status})`;
    try {
      const parsed = await response.json() as { error?: { message?: string } };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch { /* keep fallback message */ }
    const retryAfter = response.headers.get("retry-after");
    const out = new Response(JSON.stringify(anthropicErrorBody(response.status, message)), {
      status: response.status,
      headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
    });
    return out;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    const anthropicSse = responsesSseToAnthropicSse(response.body, requestedModel);
    if (stream) {
      return new Response(anthropicSse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }
    const message = await collectAnthropicMessage(anthropicSse, requestedModel);
    const isError = (message as Rec).type === "error";
    return new Response(JSON.stringify(message), {
      status: isError ? 502 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Defensive: some passthrough paths may answer JSON despite stream:true.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return anthropicErrorResponse(502, "internal replay returned a non-JSON response", "api_error");
  }
  const status = (json as Rec)?.status;
  if (status === "failed") {
    const error = (json as { error?: { message?: string } }).error;
    return anthropicErrorResponse(502, error?.message ?? "upstream request failed", "api_error");
  }
  const message = responsesJsonToAnthropicMessage(json, requestedModel);
  if (!stream) {
    return new Response(JSON.stringify(message), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  // Streaming client + JSON upstream: synthesize a minimal valid Anthropic stream.
  const encoder = new TextEncoder();
  const frames: string[] = [];
  const emit = (name: string, data: Rec) => frames.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const blocks = Array.isArray((message as Rec).content) ? (message as Rec).content as Rec[] : [];
  blocks.forEach((block, index) => {
    emit("content_block_start", { type: "content_block_start", index, content_block: block });
    emit("content_block_stop", { type: "content_block_stop", index });
  });
  emit("message_delta", { type: "message_delta", delta: { stop_reason: (message as Rec).stop_reason ?? "end_turn", stop_sequence: null }, usage: (message as Rec).usage ?? {} });
  emit("message_stop", { type: "message_stop" });
  return new Response(encoder.encode(frames.join("")), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

/** Documented approximation: serialize system+messages+tools, run the char estimator. */
export async function handleClaudeCountTokens(req: Request, config: OcxConfig): Promise<Response> {
  const disabled = claudeInboundDisabled(config);
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await readAnthropicBody(req);
  } catch (err) {
    if (err instanceof AnthropicRequestError) return anthropicErrorResponse(400, err.message);
    return anthropicErrorResponse(500, err instanceof Error ? err.message : String(err));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return anthropicErrorResponse(400, "request body must be a JSON object");
  }
  const raw = body as Rec;
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return anthropicErrorResponse(400, "model is required");
  }
  const parts: string[] = [];
  if (raw.system !== undefined) parts.push(typeof raw.system === "string" ? raw.system : JSON.stringify(raw.system));
  if (raw.messages !== undefined) parts.push(JSON.stringify(raw.messages));
  if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
  const inputTokens = Math.max(1, estimateTokens(parts.join("\n"), raw.model));
  return new Response(JSON.stringify({ input_tokens: inputTokens }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
