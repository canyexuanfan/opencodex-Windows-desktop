import { decodeEventStream } from "../lib/eventstream-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { debugProviderDiagnostic } from "../lib/debug";
import { resolveKiroApiRegion, resolveKiroProfileArn } from "../oauth/kiro";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { modelRecordValue } from "../reasoning-effort";
import { parseKiroEvent } from "./kiro-events";
import { safeKiroErrorMessage, safeKiroHttpErrorMessage } from "./kiro-errors";
import { KiroThinkingParser } from "./kiro-thinking";
import { isCompleteKiroToolInput, kiroTruncationErrorMessage } from "./kiro-truncation";
import { createKiroToolNameRegistry, fallbackToolUseId, fingerprint, invocationId, isValidKiroConversationId, mapModelId, normalizeToolId, osTag, stableConversationId } from "./kiro-wire";
import { namespacedToolName } from "../types";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxToolCall,
  OcxToolResultMessage,
  OcxUsage,
} from "../types";
import type { ProviderAdapter } from "./base";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { extractKiroImages, normalizeKiroImages, type KiroImage } from "./kiro-images";
import { fetchKiroWithRetry } from "./kiro-retry";
import { convertKiroToolContext } from "./kiro-tools";
import { neutralizeIdentity } from "./identity";
import { buildNonOpenAIToolCatalogNudgeFromNames } from "./tool-catalog-nudge";
import { KIRO_CONTINUATION_MESSAGE, MAX_KIRO_INJECTED_INSTRUCTION_CHARS } from "./kiro-constants";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.0.0";

// Payload construction (conversationState)
interface KiroToolUse {
  name: string;
  input: Record<string, unknown>; // OBJECT, not stringified
  toolUseId: string;
}
interface KiroToolResult {
  content: Array<{ text: string }>;
  status: string;
  toolUseId: string;
}
interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  origin?: string;
  userInputMessageContext?: { tools?: unknown[]; toolResults?: KiroToolResult[] };
  images?: KiroImage[];
}
interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
}

function kiroToolWireNames(tools: readonly unknown[]): string[] {
  return tools
    .map(tool => {
      const spec = (tool as { toolSpecification?: { name?: unknown } }).toolSpecification;
      return typeof spec?.name === "string" ? spec.name : undefined;
    })
    .filter((name): name is string => typeof name === "string");
}

function userContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

function usageContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(p => {
      if (p.type === "text") return p.text;
      if (p.type === "image") return `[image:${p.detail ?? "auto"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
function serializeForUsage(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}
function currentTurnUsageMessages(messages: OcxMessage[]): OcxMessage[] {
  return messages.slice(messages.map(m => m.role).lastIndexOf("assistant") + 1).filter(m => m.role !== "assistant");
}
function kiroPayloadMessages(parsed: OcxParsedRequest): OcxMessage[] {
  return parsed.context.messages;
}

function messageUsageText(msg: OcxMessage): string {
  switch (msg.role) {
    case "user":
    case "developer":
      return usageContentText(msg.content);
    case "toolResult":
      return [
        msg.toolName,
        msg.toolCallId,
        msg.isError ? "error" : "success",
        usageContentText(msg.content),
      ].filter(Boolean).join("\n");
    case "assistant":
      return "";
  }
}

function messageLogText(msg: OcxMessage): string {
  if (msg.role !== "assistant") return messageUsageText(msg);
  return msg.content.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "toolCall") return [part.name, part.id, serializeForUsage(part.arguments)].join("\n");
    return part.thinking;
  }).filter(Boolean).join("\n");
}

function shouldCountStablePromptOverhead(parsed: OcxParsedRequest): boolean {
  return !parsed.previousResponseId && !parsed.context.messages.some(m => m.role === "assistant");
}

function estimateKiroInputTokens(parsed: OcxParsedRequest): number {
  const parts = currentTurnUsageMessages(parsed.context.messages)
    .map(messageUsageText)
    .filter(Boolean);

  if (shouldCountStablePromptOverhead(parsed)) {
    if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
    if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  }

  return estimateTokens(parts.join("\n"), parsed.modelId);
}

function estimateKiroLogInputTokens(parsed: OcxParsedRequest): number {
  const parts = parsed.context.messages.map(messageLogText).filter(Boolean);
  if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
  if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  return Math.max(estimateKiroInputTokens(parsed), estimateTokens(parts.join("\n"), parsed.modelId));
}

function configuredKiroContextWindow(provider: OcxProviderConfig, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const normalizedModelId = normalizeKiroModelId(modelId);
  if (normalizedModelId === "auto") return undefined;
  const window =
    modelRecordValue(provider.modelContextWindows, modelId)
    ?? modelRecordValue(provider.modelContextWindows, normalizedModelId)
    ?? provider.contextWindow
    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalizedModelId);
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}

export type KiroReasoningMode = "native" | "emulated";

export function kiroReasoningMode(modelId: string): KiroReasoningMode {
  return normalizeKiroModelId(modelId) === "gpt-5.6-sol" ? "native" : "emulated";
}

function kiroThinkingBudget(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (!effort || effort === "none") return undefined;
  const maxTokens = parsed.options.maxOutputTokens || 4096;
  const percent: Record<string, number> = {
    minimal: 0.10,
    low: 0.20,
    medium: 0.50,
    high: 0.80,
    xhigh: 0.90,
    max: 0.95,
  };
  const ratio = percent[effort];
  return ratio === undefined ? undefined : Math.max(1, Math.floor(maxTokens * ratio));
}

function injectKiroThinkingTags(content: string, parsed: OcxParsedRequest): string {
  if (kiroReasoningMode(parsed.modelId) !== "emulated") return content;
  const budget = kiroThinkingBudget(parsed);
  if (!budget) return content;
  const instruction = [
    "Think in English for better reasoning quality.",
    "Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering.",
    "After thinking, respond in the user's language.",
  ].join("\n");
  return [
    "<thinking_mode>enabled</thinking_mode>",
    `<max_thinking_length>${budget}</max_thinking_length>`,
    `<thinking_instruction>${instruction}</thinking_instruction>`,
    "",
    content,
  ].join("\n");
}

function validateKiroCapabilities(parsed: OcxParsedRequest): void {
  const choice = parsed.options.toolChoice;
  if (choice !== undefined && choice !== "auto" && choice !== "none") {
    throw new Error("Kiro supports only automatic tool choice or tool_choice:none");
  }
  if (parsed.options.parallelToolCalls === true) {
    throw new Error("Kiro does not support parallel tool calls");
  }
  if (parsed.options.serviceTier !== undefined) {
    throw new Error("Kiro does not support service tiers");
  }
  const raw = parsed._rawBody as Record<string, unknown> | undefined;
  if (parsed._structuredOutput || raw?.text !== undefined) {
    throw new Error("Kiro does not support Responses text controls or structured output");
  }
}

type KiroTurn =
  | { kind: "user"; content: string; images: KiroImage[]; toolResults: KiroToolResult[] }
  | { kind: "assistant"; content: string; toolUses: KiroToolUse[] };

function appendTurnText(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

function boundedInjectedInstruction(text: string, used: { value: number }): string | undefined {
  const remaining = MAX_KIRO_INJECTED_INSTRUCTION_CHARS - used.value;
  if (remaining <= 0 || !text) return undefined;
  const result = text.length <= remaining ? text : text.slice(0, remaining);
  used.value += result.length;
  return result;
}

export function buildKiroPayload(parsed: OcxParsedRequest, profileArn: string | undefined): {
  payload: Record<string, unknown>;
  nameMap: Map<string, string>;
  conversationId: string;
} {
  validateKiroCapabilities(parsed);
  const modelId = mapModelId(parsed.modelId);
  const registry = createKiroToolNameRegistry();
  const toolContext = convertKiroToolContext(parsed, registry);
  const kiroTools = toolContext.tools;
  const nameMap = toolContext.nameMap;
  const systemParts: string[] = [];
  const injectedChars = { value: 0 };
  // Neutralize Codex's GPT-5 identity line so a routed Kiro model never misreports as GPT-5/OpenAI
  // and the proxy identity never leaks upstream.
  if (parsed.context.systemPrompt?.length) systemParts.push(neutralizeIdentity(parsed.context.systemPrompt.join("\n\n")));
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeFromNames(kiroToolWireNames(kiroTools));
  const boundedNudge = toolCatalogNudge ? boundedInjectedInstruction(toolCatalogNudge, injectedChars) : undefined;
  if (boundedNudge) systemParts.push(boundedNudge);
  const systemPrefix = systemParts.length > 0 ? `${systemParts.join("\n\n")}\n\n` : "";
  const turns: KiroTurn[] = [];
  const priorCalls = new Map<string, { wireName: string }>();
  const pushUser = (content: string, images: KiroImage[] = [], toolResults: KiroToolResult[] = []): void => {
    const last = turns.at(-1);
    if (last?.kind === "user") {
      last.content = appendTurnText(last.content, content);
      last.images.push(...images);
      last.toolResults.push(...toolResults);
    } else {
      turns.push({ kind: "user", content, images: [...images], toolResults: [...toolResults] });
    }
  };
  const pushAssistant = (content: string, toolUses: KiroToolUse[]): void => {
    const last = turns.at(-1);
    if (last?.kind === "assistant") {
      last.content = appendTurnText(last.content, content);
      last.toolUses.push(...toolUses);
    } else {
      turns.push({ kind: "assistant", content, toolUses: [...toolUses] });
    }
  };

  for (const msg of kiroPayloadMessages(parsed)) {
    if (msg.role === "user" || msg.role === "developer") {
      const text = userContentText((msg as { content: string | OcxContentPart[] }).content);
      const images = extractKiroImages((msg as { content: string | OcxContentPart[] }).content);
      pushUser(text, images);
    } else if (msg.role === "assistant") {
      const aMsg = msg as OcxAssistantMessage;
      const text = (aMsg.content || [])
        .filter((b): b is OcxTextContent => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolCalls = (aMsg.content || [])
        .filter((b): b is OcxToolCall => b.type === "toolCall");
      const toolUses: KiroToolUse[] = toolCalls.map(tc => {
        const toolUseId = normalizeToolId(tc.id);
        if (!toolUseId) throw new Error("Kiro history contains a tool call with an empty id");
        if (priorCalls.has(toolUseId)) throw new Error(`Kiro history contains duplicate tool call id ${JSON.stringify(tc.id)}`);
        const wireName = namespacedToolName(tc.namespace, tc.name);
        const name = registry.alias(wireName);
        priorCalls.set(toolUseId, { wireName });
        return { name, input: (tc.arguments ?? {}) as Record<string, unknown>, toolUseId };
      });
      if (!text && toolUses.length === 0) {
        const hasReasoning = aMsg.content.some(part => part.type === "thinking" && part.thinking.trim());
        if (hasReasoning) continue;
      }
      pushAssistant(text, toolUses);
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      if (tr.containsEncryptedContent) {
        throw new Error(`Kiro cannot translate encrypted output for tool call ${JSON.stringify(tr.toolCallId)}`);
      }
      const text = userContentText(tr.content);
      const images = extractKiroImages(tr.content);
      const toolUseId = normalizeToolId(tr.toolCallId);
      if (!priorCalls.has(toolUseId)) {
        throw new Error(`Kiro history contains an orphaned tool result for call ${JSON.stringify(tr.toolCallId)}`);
      }
      pushUser("", images, [{
        content: [{ text }],
        status: tr.isError ? "error" : "success",
        toolUseId,
      }]);
    }
  }

  if (turns.length === 0 || turns[0].kind === "assistant") {
    turns.unshift({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }
  if (turns.at(-1)?.kind === "assistant") {
    turns.push({ kind: "user", content: KIRO_CONTINUATION_MESSAGE, images: [], toolResults: [] });
  }

  const currentTurn = turns.pop();
  if (!currentTurn || currentTurn.kind !== "user") throw new Error("Kiro request must end with a user turn");
  const toEntry = (turn: KiroTurn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          modelId,
          origin: "AI_EDITOR",
          ...(turn.images.length > 0 ? { images: turn.images } : {}),
          ...(turn.toolResults.length > 0 ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
        },
      };
  const history = turns.map(toEntry);
  const currentEntry = toEntry(currentTurn);
  const currentUim = currentEntry.userInputMessage!;

  if (systemPrefix) {
    const firstUser = history.find(e => e.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentUim.content = systemPrefix + currentUim.content;
  }
  if (kiroTools.length > 0) {
    currentUim.userInputMessageContext = { ...(currentUim.userInputMessageContext ?? {}), tools: kiroTools };
  }
  if (!currentUim.userInputMessageContext?.toolResults && currentUim.content !== KIRO_CONTINUATION_MESSAGE) {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  const conversationId = stableConversationId(parsed);
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  const effort = parsed.options.reasoning;
  if (kiroReasoningMode(parsed.modelId) === "native" && effort && effort !== "none") {
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new Error(`Kiro gpt-5.6-sol does not support reasoning effort ${JSON.stringify(effort)}`);
    }
    payload.additionalModelRequestFields = { reasoning: { effort } };
  }
  if (profileArn) payload.profileArn = profileArn;
  return { payload, nameMap, conversationId };
}

// Stream parsing (shared by parseStream + parseResponse)
// CodeWhisperer GenerateAssistantResponse ALWAYS returns an AWS eventstream body (there is no
// non-streaming mode), so both the streaming bridge and the non-streaming web-search sidecar loop
// decode the same way — parseResponse just collects what parseStream yields.
export async function* parseKiroStream(
  response: Response,
  modelId?: string,
  inputTokens = 0,
  contextWindow?: number,
  nameMap?: Map<string, string>,
  conversationId?: string,
): AsyncGenerator<AdapterEvent> {
  if (!response.body) {
    yield { type: "error", message: "Kiro response has no body" };
    return;
  }
  let open: { id: string; name: string; chunks: string[] } | null = null;
  // CW provides no usage; accumulate output chars and emit a heuristic estimate on done so Codex's
  // usage display + auto-compact engage (see src/lib/token-estimate.ts).
  let outputChars = "";
  let contextUsagePercentage: number | undefined;
  let returnedConversationId = conversationId;
  const thinking = new KiroThinkingParser();
  const trackContent = (event: AdapterEvent): void => {
    if ("text" in event) outputChars += event.text;
  };
  function* flushTool(): Generator<AdapterEvent> {
    if (!open) return;
    const tool = open;
    open = null;
    // Restore the original wire name if it was normalized for Kiro (spaces/length), so the bridge's
    // toolNsMap (keyed by the original wire name) can route the call back to its MCP namespace.
    const restored = nameMap?.get(tool.name) ?? tool.name;
    yield { type: "tool_call_start", id: tool.id, name: restored };
    for (const chunk of tool.chunks) if (chunk) yield { type: "tool_call_delta", arguments: chunk };
    yield { type: "tool_call_end" };
  }
  try {
    for await (const msg of decodeEventStream(response.body)) {
      const mt = msg.headers[":message-type"];
      if (mt === "exception" || mt === "error") {
        // Terminal: surface the upstream error and never emit a trailing success-shaped `done`.
        open = null;
        yield { type: "error", message: safeKiroErrorMessage(msg.headers, new TextDecoder().decode(msg.payload)) };
        return;
      }
      if (mt && mt !== "event") continue;
      const ev = parseKiroEvent(msg.payload);
      if (!ev) continue;
      switch (ev.type) {
        case "usage":
          break;
        case "context_usage":
          if (ev.contextUsagePercentage !== undefined && ev.contextUsagePercentage > 0) {
            contextUsagePercentage = ev.contextUsagePercentage;
          }
          break;
        case "message_metadata":
          if (isValidKiroConversationId(ev.conversationId)) returnedConversationId = ev.conversationId;
          break;
        case "content":
          if (open) {
            open = null;
            yield { type: "error", message: kiroTruncationErrorMessage("content arrived before tool stop") };
            return;
          }
          if (ev.data) {
            for (const contentEvent of thinking.feed(ev.data)) {
              trackContent(contentEvent);
              yield contentEvent;
            }
          }
          break;
        case "tool_start": {
          for (const contentEvent of thinking.flush()) {
            trackContent(contentEvent);
            yield contentEvent;
          }
          const id = ev.toolUseId || fallbackToolUseId();
          const name = ev.name || "unknown";
          if (open) {
            if (open.id !== id || open.name !== name) {
              open = null;
              yield { type: "error", message: kiroTruncationErrorMessage("new tool started before previous tool stop") };
              return;
            }
          } else {
            open = { id, name, chunks: [] };
          }
          yield { type: "heartbeat" };
          break;
        }
        case "tool_input": {
          for (const contentEvent of thinking.flush()) {
            trackContent(contentEvent);
            yield contentEvent;
          }
          if (!open) {
            open = { id: ev.toolUseId || fallbackToolUseId(), name: ev.name || "unknown", chunks: [] };
          }
          if (open && ev.input) {
            if (open.name === "unknown" && ev.name) open.name = ev.name;
            open.chunks.push(ev.input);
            outputChars += ev.input;
          }
          yield { type: "heartbeat" };
          break;
        }
        case "tool_stop": {
          if (!open) {
            yield { type: "error", message: "Kiro response protocol error: tool stop received without an open tool call" };
            return;
          }
          const input = open.chunks.join("");
          if (!isCompleteKiroToolInput(input)) {
            open = null;
            yield { type: "error", message: kiroTruncationErrorMessage("incomplete tool input JSON") };
            return;
          }
          yield* flushTool();
          break;
        }
        case "truncation":
          open = null;
          yield { type: "error", message: kiroTruncationErrorMessage(ev.data) };
          return;
      }
    }
    for (const contentEvent of thinking.flush()) {
      trackContent(contentEvent);
      yield contentEvent;
    }
    if (open) {
      const input = open.chunks.join("");
      if (!isCompleteKiroToolInput(input)) {
        open = null;
        yield { type: "error", message: kiroTruncationErrorMessage("stream ended before tool stop") };
        return;
      }
      yield* flushTool();
    }
    const outputTokens = estimateTokens(outputChars, modelId);
    const usage: OcxUsage = { inputTokens, outputTokens, estimated: true };
    if (contextUsagePercentage !== undefined) {
      debugProviderDiagnostic("kiro", "context_usage", {
        contextUsagePercentage,
        ...(contextWindow ? { configuredContextWindow: contextWindow } : {}),
      });
    }
    yield {
      type: "done",
      usage,
      ...(returnedConversationId ? { providerState: { kiro: { conversationId: returnedConversationId } } } : {}),
    };
  } catch (err) {
    yield { type: "error", message: safeKiroErrorMessage({}, err instanceof Error ? err.message : String(err)) };
  }
}

// Adapter
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  let toolNameMap: Map<string, string> | undefined;
  let conversationId: string | undefined;
  return {
    name: "kiro",
    async buildRequest(parsed: OcxParsedRequest) {
      if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
        throw new Error("kiro token missing — run ocx login kiro");
      }
      const region = resolveKiroApiRegion();
      const profileArn = resolveKiroProfileArn();
      const fp = fingerprint().slice(0, 64);
      const headers: Record<string, string> = {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/x-amz-json-1.0",
        accept: "application/vnd.amazon.eventstream",
        "x-amz-target": AMZ_TARGET,
        "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": invocationId(),
      };
      if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
      // CodeWhisperer GenerateAssistantResponse has no reasoning_effort field. Match kiro-gateway's
      // fake-reasoning contract by injecting effort-derived thinking tags into only the current user turn.
      const built = buildKiroPayload(parsed, profileArn);
      toolNameMap = built.nameMap;
      conversationId = built.conversationId;
      // Generous image pipeline (devlog/260714_image_normalization_pipeline/050):
      // tier-normalize + cap images before serialization so bodyBytes below reflects
      // the normalized size.
      await normalizeKiroImages(built.payload);
      const body = JSON.stringify(built.payload);
      debugProviderDiagnostic("kiro", "request", {
        region,
        requestedModel: parsed.modelId,
        bodyBytes: new TextEncoder().encode(body).length,
        messageCount: kiroPayloadMessages(parsed).length,
        toolCount: parsed.context.tools?.length ?? 0,
        hasProfileArn: Boolean(profileArn),
        hasPreviousResponseId: Boolean(parsed.previousResponseId),
      });
      // CW returns no usage. Codex adds each response's usage into its session total; report only the
      // current-turn input delta so old history is not repeatedly added to Codex's visible token usage.
      modelId = parsed.modelId;
      contextWindow = configuredKiroContextWindow(provider, parsed.modelId);
      inputTokens = estimateKiroInputTokens(parsed);
      return {
        url: `https://runtime.${region}.kiro.dev/`,
        method: "POST",
        headers,
        body,
        usageLog: { inputTokens: estimateKiroLogInputTokens(parsed), estimated: true },
      };
    },

    parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(response, modelId, inputTokens, contextWindow, toolNameMap, conversationId);
    },

    fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      return fetchKiroWithRetry(request, ctx);
    },

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      return safeKiroHttpErrorMessage(status, headers, payloadText);
    },

    // Non-streaming path used by the web-search sidecar loop (loop.ts runs each iteration
    // non-streamed so it can inspect tool calls). CW only ever event-streams, so we drain the
    // same decoder into an array. Without this, any Codex request that includes the web_search
    // tool failed with "web-search sidecar requires a non-streaming adapter" (kiro-only).
    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const e of parseKiroStream(response, modelId, inputTokens, contextWindow, toolNameMap, conversationId)) events.push(e);
      return events;
    },
  };
}
