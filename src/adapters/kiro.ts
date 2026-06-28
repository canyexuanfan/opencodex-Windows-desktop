/**
 * Kiro (AWS CodeWhisperer) adapter — GenerateAssistantResponse over AWS eventstream.
 *
 * buildRequest: Responses-derived OcxParsedRequest → CodeWhisperer `conversationState`
 *   (strict user/assistant alternation, toolResult adjacency, toolUses[].input as a JSON OBJECT)
 *   + KiroIDE-spoof fingerprint headers + Bearer token (provider.apiKey, pre-resolved by the server).
 * parseStream: decodeEventStream (Phase 1) → discriminate stop/input/name (CW repeats name on every
 *   tool event) → opencodex AdapterEvent variants.
 *
 * Ported from jawcode packages/ai/src/providers/kiro.ts with the 260628 live-confirmed fixes.
 * profileArn/region are resolved here at request time (not stored in the credential).
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { decodeEventStream } from "../lib/eventstream-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { resolveKiroProfileArn, resolveKiroRegion } from "../oauth/kiro";
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
} from "../types";
import type { ProviderAdapter } from "./base";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Anti-detection fingerprint / headers
// ---------------------------------------------------------------------------
let cachedFp: string | undefined;
function fingerprint(): string {
  if (cachedFp) return cachedFp;
  try {
    cachedFp = createHash("sha256").update(`${hostname()}-${userInfo().username}-kiro-ocx`).digest("hex");
  } catch {
    cachedFp = createHash("sha256").update("default-kiro-ocx").digest("hex");
  }
  return cachedFp;
}
function osTag(): string {
  const p = process.platform;
  if (p === "darwin") return "macos#24.0.0";
  if (p === "win32") return "win32#10.0.26100";
  return "linux#6.8.0";
}

/** registry model id → CodeWhisperer model id (only "kiro-auto" is prefixed). */
function mapModelId(id: string): string {
  return id === "kiro-auto" ? "auto" : id.replace(/^kiro-/, "");
}

/** CodeWhisperer toolUseId constraint: ^[a-zA-Z0-9_-]{1,64}$ — normalize both sides identically. */
function normalizeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 64 ? s.slice(0, 64) : s;
}

// ---------------------------------------------------------------------------
// Payload construction (conversationState)
// ---------------------------------------------------------------------------
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
// CodeWhisperer native image part (matches Kiro IDE wire format): the base64 bytes live directly in
// userInputMessage.images, NOT in userInputMessageContext. Verified against kiro-gateway.
interface KiroImage {
  format: string; // "jpeg" | "png" | "webp" | "gif" — derived from the media subtype
  source: { bytes: string }; // pure base64, no "data:...;base64," prefix
}
interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
}

function userContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

// CodeWhisperer accepts images natively on userInputMessage. Codex sends each image as a `data:` URL
// (base64) or a remote https URL. Only data URLs can be inlined as bytes here; remote URLs are not
// fetchable at request-build time, so they are skipped (matching kiro-gateway's documented behavior).
function parseDataUrlImage(imageUrl: string): KiroImage | undefined {
  if (!imageUrl.startsWith("data:")) return undefined; // remote https — not fetchable here
  const comma = imageUrl.indexOf(",");
  if (comma === -1) return undefined;
  const header = imageUrl.slice(5, comma); // strip "data:" → "image/png;base64"
  const bytes = imageUrl.slice(comma + 1);
  if (!bytes) return undefined;
  const mediaType = header.split(";")[0] || "image/jpeg"; // "image/png"
  const format = mediaType.includes("/") ? mediaType.split("/")[1] : mediaType; // "png"
  return { format: format || "jpeg", source: { bytes } };
}

function extractKiroImages(content: string | OcxContentPart[]): KiroImage[] {
  if (typeof content === "string") return [];
  const out: KiroImage[] = [];
  for (const p of content) {
    if (p.type !== "image") continue;
    const img = parseDataUrlImage(p.imageUrl);
    if (img) out.push(img);
  }
  return out;
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

function convertTools(parsed: OcxParsedRequest): unknown[] {
  const tools = parsed.context.tools ?? [];
  return tools.map(t => ({
    toolSpecification: {
      name: t.name.slice(0, 64),
      description: (t.description || `Tool: ${t.name}`).slice(0, 1024),
      inputSchema: { json: (t.parameters ?? {}) as Record<string, unknown> },
    },
  }));
}

function stableConversationId(parsed: OcxParsedRequest): string {
  const msgs = parsed.context.messages;
  if (!msgs || msgs.length === 0) return randomUUID().slice(0, 16);
  const key = (msgs.length <= 3 ? msgs : [...msgs.slice(0, 3), msgs[msgs.length - 1]])
    .map(m => `${m.role}:${JSON.stringify((m as { content?: unknown }).content ?? "").slice(0, 100)}`)
    .join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function serializeForUsage(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function currentTurnInputMessages(messages: OcxMessage[]): OcxMessage[] {
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  return messages.slice(lastAssistant + 1).filter(m => m.role !== "assistant");
}

function kiroPayloadMessages(parsed: OcxParsedRequest): OcxMessage[] {
  return parsed.previousResponseId ? currentTurnInputMessages(parsed.context.messages) : parsed.context.messages;
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

function shouldCountStablePromptOverhead(parsed: OcxParsedRequest): boolean {
  return !parsed.previousResponseId && !parsed.context.messages.some(m => m.role === "assistant");
}

function estimateKiroInputTokens(parsed: OcxParsedRequest): number {
  const parts = currentTurnInputMessages(parsed.context.messages)
    .map(messageUsageText)
    .filter(Boolean);

  if (shouldCountStablePromptOverhead(parsed)) {
    if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
    if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  }

  return estimateTokens(parts.join("\n"), parsed.modelId);
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
    xhigh: 0.95,
    max: 0.95,
  };
  const ratio = percent[effort];
  return ratio === undefined ? undefined : Math.max(1, Math.floor(maxTokens * ratio));
}

function injectKiroThinkingTags(content: string, parsed: OcxParsedRequest): string {
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

export function buildKiroPayload(parsed: OcxParsedRequest, profileArn: string | undefined): Record<string, unknown> {
  const modelId = mapModelId(parsed.modelId);
  const kiroTools = convertTools(parsed);
  let systemPrefix = "";
  if (!parsed.previousResponseId && parsed.context.systemPrompt?.length) systemPrefix = `${parsed.context.systemPrompt.join("\n\n")}\n\n`;

  const mkUser = (content: string, images?: KiroImage[]): KiroHistoryEntry => ({
    userInputMessage: {
      content,
      modelId,
      origin: "AI_EDITOR",
      ...(images && images.length > 0 ? { images } : {}),
    },
  });
  const history: KiroHistoryEntry[] = [];
  let pending: KiroToolResult[] = [];
  let lastRole = "";
  const attachPending = (entry: KiroHistoryEntry): void => {
    if (pending.length === 0) return;
    const uim = entry.userInputMessage!;
    uim.userInputMessageContext = { ...(uim.userInputMessageContext ?? {}), toolResults: pending };
    pending = [];
  };

  for (const msg of kiroPayloadMessages(parsed)) {
    if (msg.role === "user" || msg.role === "developer") {
      const text = userContentText((msg as { content: string | OcxContentPart[] }).content);
      const images = extractKiroImages((msg as { content: string | OcxContentPart[] }).content);
      if (pending.length === 0 && lastRole === "user") {
        history.push({ assistantResponseMessage: { content: "(acknowledged)" } });
      }
      const entry = mkUser(text, images);
      attachPending(entry);
      history.push(entry);
      lastRole = "user";
    } else if (msg.role === "assistant") {
      if (pending.length > 0) {
        const carrier = mkUser("(tool results)");
        attachPending(carrier);
        history.push(carrier);
        lastRole = "user";
      }
      const aMsg = msg as OcxAssistantMessage;
      const text = (aMsg.content || [])
        .filter((b): b is OcxTextContent => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolUses: KiroToolUse[] = (aMsg.content || [])
        .filter((b): b is OcxToolCall => b.type === "toolCall")
        .map(tc => ({ name: tc.name, input: (tc.arguments ?? {}) as Record<string, unknown>, toolUseId: normalizeToolId(tc.id) }));
      if (lastRole === "assistant") history.push(mkUser("(continue)"));
      const entry: KiroHistoryEntry = { assistantResponseMessage: { content: text } };
      if (toolUses.length > 0) entry.assistantResponseMessage!.toolUses = toolUses;
      history.push(entry);
      lastRole = "assistant";
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      const text = userContentText(tr.content);
      pending.push({
        content: [{ text: text || "(empty)" }],
        status: tr.isError ? "error" : "success",
        toolUseId: normalizeToolId(tr.toolCallId),
      });
    }
  }

  let currentEntry: KiroHistoryEntry;
  if (pending.length > 0) {
    currentEntry = mkUser("(tool results)");
    attachPending(currentEntry);
  } else if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentEntry = history.pop()!;
  } else {
    currentEntry = mkUser("(continue)");
  }
  const currentUim = currentEntry.userInputMessage!;

  if (systemPrefix) {
    const firstUser = history.find(e => e.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentUim.content = systemPrefix + currentUim.content;
  }
  if (kiroTools.length > 0) {
    currentUim.userInputMessageContext = { ...(currentUim.userInputMessageContext ?? {}), tools: kiroTools };
  }
  if (!currentUim.userInputMessageContext?.toolResults && currentUim.content !== "(continue)") {
    currentUim.content = injectKiroThinkingTags(currentUim.content, parsed);
  }

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: stableConversationId(parsed),
      currentMessage: { userInputMessage: currentUim },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  if (profileArn) payload.profileArn = profileArn;
  return payload;
}

// ---------------------------------------------------------------------------
// Stream event parsing — discriminate stop/input/name (NOT name alone)
// ---------------------------------------------------------------------------
interface ParsedKiroEvent {
  type: "content" | "tool_start" | "tool_input" | "tool_stop";
  data?: string;
  name?: string;
  toolUseId?: string;
  input?: string;
}
export function parseKiroEvent(payload: Uint8Array): ParsedKiroEvent | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload).trim();
  } catch {
    return null;
  }
  if (!text.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if ("content" in parsed && typeof parsed.content === "string") return { type: "content", data: parsed.content };
  const toolUseId = typeof parsed.toolUseId === "string" ? parsed.toolUseId : undefined;
  const name = typeof parsed.name === "string" ? parsed.name : undefined;
  if (parsed.stop === true) return { type: "tool_stop", toolUseId };
  if ("input" in parsed) {
    const input =
      typeof parsed.input === "object" && parsed.input !== null
        ? JSON.stringify(parsed.input)
        : typeof parsed.input === "string"
          ? parsed.input
          : "";
    return { type: "tool_input", input, name, toolUseId };
  }
  if (name !== undefined) return { type: "tool_start", name, toolUseId: toolUseId || `toolu_${randomUUID().slice(0, 8)}` };
  return null;
}

// ---------------------------------------------------------------------------
// Stream parsing (shared by parseStream + parseResponse)
// ---------------------------------------------------------------------------
// CodeWhisperer GenerateAssistantResponse ALWAYS returns an AWS eventstream body (there is no
// non-streaming mode), so both the streaming bridge and the non-streaming web-search sidecar loop
// decode the same way — parseResponse just collects what parseStream yields.
export async function* parseKiroStream(
  response: Response,
  modelId?: string,
  inputTokens = 0,
): AsyncGenerator<AdapterEvent> {
  if (!response.body) {
    yield { type: "error", message: "Kiro response has no body" };
    return;
  }
  let open: { id: string; name: string } | null = null;
  // CW provides no usage; accumulate output chars and emit a heuristic estimate on done so Codex's
  // usage display + auto-compact engage (see src/lib/token-estimate.ts).
  let outputChars = "";
  try {
    for await (const msg of decodeEventStream(response.body)) {
      const mt = msg.headers[":message-type"];
      if (mt === "exception" || mt === "error") {
        // Terminal: an upstream exception/error ends the response. Close any dangling tool call so
        // the bridge's tool-call bracketing stays balanced, surface the error, and stop — never fall
        // through to the trailing `done`, which would make a failed call look partially successful.
        if (open) {
          yield { type: "tool_call_end" };
          open = null;
        }
        yield { type: "error", message: new TextDecoder().decode(msg.payload).slice(0, 500) };
        return;
      }
      if (mt && mt !== "event") continue;
      const ev = parseKiroEvent(msg.payload);
      if (!ev) continue;
      switch (ev.type) {
        case "content":
          if (ev.data) {
            outputChars += ev.data;
            yield { type: "text_delta", text: ev.data };
          }
          break;
        case "tool_start": {
          if (open) yield { type: "tool_call_end" };
          open = { id: ev.toolUseId!, name: ev.name || "unknown" };
          yield { type: "tool_call_start", id: open.id, name: open.name };
          break;
        }
        case "tool_input": {
          if (!open && ev.toolUseId) {
            open = { id: ev.toolUseId, name: ev.name || "unknown" };
            yield { type: "tool_call_start", id: open.id, name: open.name };
          }
          if (open && ev.input) {
            outputChars += ev.input;
            yield { type: "tool_call_delta", arguments: ev.input };
          }
          break;
        }
        case "tool_stop":
          if (open) {
            yield { type: "tool_call_end" };
            open = null;
          }
          break;
      }
    }
    if (open) yield { type: "tool_call_end" };
    yield {
      type: "done",
      usage: { inputTokens, outputTokens: estimateTokens(outputChars, modelId) },
    };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure (resolveAdapter builds a fresh adapter per request — server.ts:440 — so this
  // is race-free) carrying the heuristic input-token estimate from buildRequest into the stream.
  let inputTokens = 0;
  let modelId: string | undefined;
  return {
    name: "kiro",
    buildRequest(parsed: OcxParsedRequest) {
      const region = resolveKiroRegion();
      const profileArn = resolveKiroProfileArn();
      const fp = fingerprint().slice(0, 64);
      const headers: Record<string, string> = {
        authorization: `Bearer ${provider.apiKey ?? ""}`,
        "content-type": "application/x-amz-json-1.0",
        accept: "application/vnd.amazon.eventstream",
        "x-amz-target": AMZ_TARGET,
        "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": randomUUID(),
      };
      if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
      // CodeWhisperer GenerateAssistantResponse has no reasoning_effort field. Match kiro-gateway's
      // fake-reasoning contract by injecting effort-derived thinking tags into only the current user turn.
      const body = JSON.stringify(buildKiroPayload(parsed, profileArn));
      // CW returns no usage. Codex adds each response's usage into its session total; report only the
      // current-turn input delta so old history is not repeatedly added to Codex's visible token usage.
      modelId = parsed.modelId;
      inputTokens = estimateKiroInputTokens(parsed);
      return {
        url: `https://runtime.${region}.kiro.dev/`,
        method: "POST",
        headers,
        body,
      };
    },

    parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(response, modelId, inputTokens);
    },

    // Non-streaming path used by the web-search sidecar loop (loop.ts runs each iteration
    // non-streamed so it can inspect tool calls). CW only ever event-streams, so we drain the
    // same decoder into an array. Without this, any Codex request that includes the web_search
    // tool failed with "web-search sidecar requires a non-streaming adapter" (kiro-only).
    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const e of parseKiroStream(response, modelId, inputTokens)) events.push(e);
      return events;
    },
  };
}
