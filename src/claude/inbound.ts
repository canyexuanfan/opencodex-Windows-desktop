/**
 * Claude Code inbound: Anthropic Messages API request -> internal /v1/responses body.
 *
 * Design (devlog/260711_claude_inbound/010, 003_evidence.md):
 *  - translate-and-replay: the produced body MUST pass the real responsesRequestSchema
 *    parse so routing/OAuth/pool/failover are inherited unchanged.
 *  - thinking/redacted_thinking blocks on replay are DROPPED (v1 policy) — routed
 *    providers carry reasoning in Responses items/ocxr1 envelopes instead.
 *  - thinking.budget_tokens is NEVER forwarded raw; it maps to an effort tier.
 *  - top_k is accepted and silently dropped (no Responses equivalent, CCR parity).
 */
import type { OcxClaudeCodeConfig } from "../types";
import { resolveAlias } from "./alias";
import { createHash } from "node:crypto";

export class AnthropicRequestError extends Error {}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Alias first, then modelMap: exact id, then date-suffix-stripped (`-\d{8}$`), else passthrough. */
export function resolveInboundModel(model: string, cc?: OcxClaudeCodeConfig): string {
  const aliased = resolveAlias(model);
  if (aliased) return aliased;
  const map = cc?.modelMap ?? {};
  const exact = map[model];
  if (typeof exact === "string" && exact.length > 0) return exact;
  const stripped = model.replace(/-\d{8}$/, "");
  const dateless = map[stripped];
  if (typeof dateless === "string" && dateless.length > 0) return dateless;
  return model;
}

/** budget_tokens ladder -> Responses reasoning effort (003: real API min is 1024; never forward raw). */
export function effortForThinkingBudget(budget: number): string {
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Adaptive-thinking wire (devlog 080): Claude Code /effort sends
 * `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}` (verified by local
 * capture of claude 2.1.207 and CLIProxyAPI#1540). Forward the level verbatim when it
 * is a known Responses effort; unknown strings are dropped so downstream defaults win.
 */
const OUTPUT_CONFIG_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export function effortFromOutputConfig(outputConfig: unknown): string | undefined {
  if (!isRec(outputConfig)) return undefined;
  const effort = outputConfig.effort;
  return typeof effort === "string" && OUTPUT_CONFIG_EFFORTS.has(effort) ? effort : undefined;
}

function systemToInstructions(system: unknown): string | undefined {
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      if (isRec(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function imageBlockToInputImage(block: Rec): Rec | null {
  const source = block.source;
  if (!isRec(source)) return null;
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "input_image", image_url: `data:${media};base64,${source.data}` };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  return null;
}

function toolResultOutput(block: Rec): string | Rec[] {
  const isError = block.is_error === true;
  const content = block.content;
  if (typeof content === "string") return isError ? `[tool error] ${content}` : content;
  if (Array.isArray(content)) {
    const out: Rec[] = [];
    for (const item of content) {
      if (!isRec(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        out.push({ type: "input_text", text: item.text });
      } else if (item.type === "image") {
        const img = imageBlockToInputImage(item);
        if (img) out.push(img);
      }
    }
    if (isError) out.unshift({ type: "input_text", text: "[tool error]" });
    if (out.length === 0) return isError ? "[tool error]" : "";
    return out;
  }
  return isError ? "[tool error]" : "";
}

function pushUserMessage(input: Rec[], blocks: Rec[]): void {
  if (blocks.length === 0) return;
  input.push({ type: "message", role: "user", content: blocks });
}

/**
 * Claude Code (observed 2026-07-11, real CLI smoke) sends `role:"system"` entries in
 * `messages` despite the published API having no system role. Map them to Responses
 * instructions text: the native ChatGPT backend rejects system message items in
 * `input` ("System messages are not allowed", verified live), so folding into
 * `instructions` is the only shape that works on every route.
 */
function systemMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (isRec(raw) && raw.type === "text" && typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n\n");
}

function userMessageToItems(content: unknown, input: Rec[]): void {
  if (typeof content === "string") {
    if (content.length > 0) pushUserMessage(input, [{ type: "input_text", text: content }]);
    return;
  }
  if (!Array.isArray(content)) return;
  // Preserve block order: tool_result blocks become standalone function_call_output
  // items; contiguous text/image runs become one user message.
  let pending: Rec[] = [];
  for (const raw of content) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "text":
        if (typeof raw.text === "string") pending.push({ type: "input_text", text: raw.text });
        break;
      case "image": {
        const img = imageBlockToInputImage(raw);
        if (img) pending.push(img);
        break;
      }
      case "tool_result": {
        pushUserMessage(input, pending);
        pending = [];
        if (typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) {
          throw new AnthropicRequestError("tool_result requires tool_use_id");
        }
        input.push({ type: "function_call_output", call_id: raw.tool_use_id, output: toolResultOutput(raw) });
        break;
      }
      case "document":
        // No Responses equivalent for raw document blocks; surface the title so the
        // model at least sees the attachment happened.
        pending.push({ type: "input_text", text: `[document${typeof raw.title === "string" ? `: ${raw.title}` : ""}]` });
        break;
      default:
        break; // thinking/redacted_thinking never appear in user messages; ignore unknowns
    }
  }
  pushUserMessage(input, pending);
}

function assistantMessageToItems(content: unknown, input: Rec[]): void {
  if (typeof content === "string") {
    if (content.length > 0) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;
  let pendingText: Rec[] = [];
  const flush = () => {
    if (pendingText.length > 0) input.push({ type: "message", role: "assistant", content: pendingText });
    pendingText = [];
  };
  for (const raw of content) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "text":
        if (typeof raw.text === "string") pendingText.push({ type: "output_text", text: raw.text });
        break;
      case "tool_use": {
        flush();
        if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.name !== "string" || raw.name.length === 0) {
          throw new AnthropicRequestError("tool_use requires id and name");
        }
        input.push({ type: "function_call", call_id: raw.id, name: raw.name, arguments: JSON.stringify(raw.input ?? {}) });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break; // v1 policy: dropped on replay (003 evidence — safe for routed providers)
      default:
        break;
    }
  }
  flush();
}

function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type.startsWith("web_search")) {
      out.push({ type: "web_search" }); // hosted sidecar path
      continue;
    }
    if (typeof raw.name === "string" && raw.name.length > 0 && isRec(raw.input_schema)) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        parameters: raw.input_schema as Record<string, unknown>,
      });
      continue;
    }
    // Other server tools (bash_*, text_editor_*, ...) have no routed equivalent: drop.
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (!isRec(choice)) return;
  if (choice.disable_parallel_tool_use === true) body.parallel_tool_calls = false;
  switch (choice.type) {
    case "auto": body.tool_choice = "auto"; break;
    case "none": body.tool_choice = "none"; break;
    case "any": body.tool_choice = "required"; break;
    case "tool":
      if (typeof choice.name !== "string" || choice.name.length === 0) {
        throw new AnthropicRequestError("tool_choice.tool requires a name");
      }
      body.tool_choice = { type: "function", name: choice.name };
      break;
    default: break;
  }
}

/**
 * Translate an Anthropic Messages request body into a /v1/responses request body.
 * Throws AnthropicRequestError (-> 400 invalid_request_error) on malformed input.
 */
export function anthropicToResponsesBody(raw: unknown, cc?: OcxClaudeCodeConfig): Rec {
  if (!isRec(raw)) throw new AnthropicRequestError("request body must be a JSON object");
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new AnthropicRequestError("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new AnthropicRequestError("messages must be a non-empty array");
  }

  const input: Rec[] = [];
  const systemParts: string[] = [];
  const topLevelSystem = systemToInstructions(raw.system);
  if (topLevelSystem !== undefined) systemParts.push(topLevelSystem);
  for (const msg of raw.messages) {
    if (!isRec(msg)) throw new AnthropicRequestError("each message must be an object");
    if (msg.role === "user") userMessageToItems(msg.content, input);
    else if (msg.role === "assistant") assistantMessageToItems(msg.content, input);
    else if (msg.role === "system") {
      const text = systemMessageText(msg.content);
      if (text.length > 0) systemParts.push(text);
    }
    else throw new AnthropicRequestError(`unsupported message role: ${String(msg.role)}`);
  }

  const body: Rec = {
    model: resolveInboundModel(raw.model, cc),
    input,
    store: false,
    stream: raw.stream === true,
  };

  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");

  const tools = toolsToResponses(raw.tools);
  if (tools) body.tools = tools;
  toolChoiceToResponses(raw.tool_choice, body);

  if (typeof raw.max_tokens === "number") body.max_output_tokens = raw.max_tokens;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  // top_k: accepted and dropped (no Responses equivalent).
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length > 0) {
    body.stop = raw.stop_sequences.filter((s): s is string => typeof s === "string");
  }
  if (isRec(raw.metadata) && typeof raw.metadata.user_id === "string") {
    body.user = raw.metadata.user_id;
    // OpenAI-side prompt caching is routed by prompt_cache_key (Codex clients send
    // their session id; without it consecutive /v1/messages turns reported
    // cached_tokens: 0 on the ChatGPT backend — devlog 090). Claude Code's
    // metadata.user_id embeds the session uuid, so hashing it yields a stable
    // per-session key with a bounded length/charset.
    body.prompt_cache_key = createHash("sha256").update(raw.metadata.user_id).digest("hex").slice(0, 32);
  }

  const thinking = raw.thinking;
  const outputConfigEffort = effortFromOutputConfig(raw.output_config);
  const thinkingDisabled = isRec(thinking) && thinking.type === "disabled";
  if (!thinkingDisabled && (isRec(thinking) || outputConfigEffort !== undefined)) {
    const reasoning: Rec = { summary: "auto" };
    if (outputConfigEffort !== undefined) {
      // Adaptive wire: /effort arrives as output_config.effort (devlog 080).
      reasoning.effort = outputConfigEffort;
    } else if (isRec(thinking) && thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
      reasoning.effort = effortForThinkingBudget(thinking.budget_tokens);
    }
    body.reasoning = reasoning;
  }

  return body;
}
