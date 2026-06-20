import Anthropic from "@anthropic-ai/sdk";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.mjs";
import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxThinkingContent, OcxToolCall, OcxUsage } from "../types";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
import { parseDataUrl } from "./image";

function toContentPart(p: OcxContentPart): unknown {
  if (p.type === "image") {
    const data = parseDataUrl(p.imageUrl);
    return data
      ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.base64 } }
      : { type: "image", source: { type: "url", url: p.imageUrl } };
  }
  return { type: "text", text: p.text };
}

const DEFAULT_MAX_TOKENS = 8192;
const REASONING_MAX_TOKENS_CEILING = 32_000;
const MIN_THINKING_BUDGET = 1024;
const OUTPUT_HEADROOM = 8192;
const OUTPUT_FLOOR = 4096;

function reasoningBudget(effort: string): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "high": return 16384;
    case "xhigh": return 24576;
    case "max": return 32000;
    case "medium":
    default: return 8192;
  }
}

function usageFromSdk(usage: { output_tokens: number } | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: 0, outputTokens: usage.output_tokens };
}

function buildMessages(parsed: OcxParsedRequest, isOAuth: boolean): { system: unknown; messages: unknown[] } {
  const systemText = parsed.context.systemPrompt?.join("\n\n") || undefined;
  const system = isOAuth
    ? [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, ...(systemText ? [{ type: "text", text: systemText }] : [])]
    : systemText;

  const messages: unknown[] = [];
  for (const msg of parsed.context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        const content = typeof msg.content === "string"
          ? msg.content
          : (msg.content as OcxContentPart[]).map(toContentPart);
        messages.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const content: unknown[] = [];
        for (const part of aMsg.content) {
          if (part.type === "text") content.push({ type: "text", text: (part as OcxTextContent).text });
          else if (part.type === "thinking") {
            const t = part as OcxThinkingContent;
            content.push({ type: "thinking", thinking: t.thinking, ...(t.signature ? { signature: t.signature } : {}) });
          } else if (part.type === "toolCall") {
            const tc = part as OcxToolCall;
            content.push({ type: "tool_use", id: tc.id, name: isOAuth ? applyClaudeToolPrefix(tc.name) : tc.name, input: tc.arguments });
          }
        }
        messages.push({ role: "assistant", content });
        break;
      }
      case "toolResult": {
        const trContent = typeof msg.content === "string"
          ? msg.content
          : (msg.content as OcxContentPart[]).map(toContentPart);
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: trContent }] });
        break;
      }
    }
  }
  return { system, messages };
}

function buildTools(parsed: OcxParsedRequest, isOAuth: boolean): unknown[] | undefined {
  if (!parsed.context.tools?.length) return undefined;
  return parsed.context.tools.map(t => ({
    name: isOAuth ? applyClaudeToolPrefix(t.name) : t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function createAnthropicSdkAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const isOAuth = provider.authMode === "oauth";

  return {
    name: "anthropic-sdk",

    buildRequest(parsed: OcxParsedRequest) {
      const { system, messages } = buildMessages(parsed, isOAuth);
      const tools = buildTools(parsed, isOAuth);
      const body: Record<string, unknown> = {
        model: parsed.modelId, messages, stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (system) body.system = system;
      if (tools) body.tools = tools;
      if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
      if (parsed.options.stopSequences) body.stop_sequences = parsed.options.stopSequences;
      if (parsed.options.reasoning) {
        const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
        const wantBudget = reasoningBudget(parsed.options.reasoning);
        const maxTokens = Math.min(REASONING_MAX_TOKENS_CEILING, Math.max(maxOut, wantBudget + OUTPUT_HEADROOM));
        const budget = Math.max(MIN_THINKING_BUDGET, Math.min(wantBudget, maxTokens - OUTPUT_FLOOR));
        body.max_tokens = maxTokens;
        body.thinking = { type: "enabled", budget_tokens: budget };
        delete body.temperature;
        delete body.top_p;
      }
      if (parsed.options.toolChoice) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") body.tool_choice = { type: "auto" };
        else if (tc === "none") body.tool_choice = { type: "none" };
        else if (tc === "required") body.tool_choice = { type: "any" };
        else if (typeof tc === "object" && "name" in tc) body.tool_choice = { type: "tool", name: isOAuth ? applyClaudeToolPrefix(tc.name) : tc.name };
      }
      const url = `${provider.baseUrl}/v1/messages`;
      const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (isOAuth) {
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      } else if (provider.apiKey) {
        headers["x-api-key"] = provider.apiKey;
      }
      if (provider.headers) Object.assign(headers, provider.headers);
      return { url, method: "POST", headers, body: JSON.stringify(body) };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "anthropic-sdk adapter uses executeStream; parseStream should not be called directly" };
    },

    async *executeStream(parsed: OcxParsedRequest, signal?: AbortSignal): AsyncGenerator<AdapterEvent> {
      const { system, messages } = buildMessages(parsed, isOAuth);
      const tools = buildTools(parsed, isOAuth);

      const params: Record<string, unknown> = {
        model: parsed.modelId, messages, stream: true,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (system) params.system = system;
      if (tools) params.tools = tools;
      if (parsed.options.temperature !== undefined) params.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) params.top_p = parsed.options.topP;
      if (parsed.options.stopSequences) params.stop_sequences = parsed.options.stopSequences;

      if (parsed.options.reasoning) {
        const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
        const wantBudget = reasoningBudget(parsed.options.reasoning);
        const maxTokens = Math.min(REASONING_MAX_TOKENS_CEILING, Math.max(maxOut, wantBudget + OUTPUT_HEADROOM));
        const budget = Math.max(MIN_THINKING_BUDGET, Math.min(wantBudget, maxTokens - OUTPUT_FLOOR));
        params.max_tokens = maxTokens;
        params.thinking = { type: "enabled", budget_tokens: budget };
        delete params.temperature;
        delete params.top_p;
      }

      if (parsed.options.toolChoice) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") params.tool_choice = { type: "auto" };
        else if (tc === "none") params.tool_choice = { type: "none" };
        else if (tc === "required") params.tool_choice = { type: "any" };
        else if (typeof tc === "object" && "name" in tc) params.tool_choice = { type: "tool", name: isOAuth ? applyClaudeToolPrefix(tc.name) : tc.name };
      }

      const sdkHeaders: Record<string, string> = {};
      if (isOAuth) sdkHeaders["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (provider.headers) Object.assign(sdkHeaders, provider.headers);

      const client = new Anthropic({
        apiKey: provider.apiKey ?? "",
        baseURL: `${provider.baseUrl}/v1`,
        maxRetries: 2,
        defaultHeaders: sdkHeaders,
        ...(isOAuth ? { authToken: provider.apiKey } : {}),
      });

      let stream: AsyncIterable<RawMessageStreamEvent>;
      try {
        stream = await client.messages.create(
          params as unknown as Parameters<typeof client.messages.create>[0],
          { signal },
        ) as AsyncIterable<RawMessageStreamEvent>;
      } catch (err) {
        yield { type: "error", message: err instanceof Error ? err.message : String(err) };
        return;
      }

      let inToolUse = false;
      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              const name = isOAuth ? stripClaudeToolPrefix(event.content_block.name) : event.content_block.name;
              inToolUse = true;
              yield { type: "tool_call_start", id: event.content_block.id, name };
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
            else if (event.delta.type === "thinking_delta") yield { type: "thinking_delta", thinking: event.delta.thinking };
            else if (event.delta.type === "input_json_delta") yield { type: "tool_call_delta", arguments: event.delta.partial_json };
            break;
          case "content_block_stop":
            if (inToolUse) { yield { type: "tool_call_end" }; inToolUse = false; }
            break;
          case "message_delta":
            yield { type: "done", usage: usageFromSdk(event.usage) };
            break;
          default:
            break;
        }
      }
    },
  };
}
