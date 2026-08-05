import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import type { AdapterEvent, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool, OcxUsage } from "../types";
import { isAllowedToolChoice, namespacedToolName, toolAllowedByChoice } from "../types";
import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import type { TranslatorBudget } from "../lib/translator-budget";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { configuredReasoningEfforts } from "../reasoning-effort";
import { commandCodeReasoningEfforts, refreshCommandCodeReasoningEfforts } from "../providers/command-code-efforts";
import { identifyRoutedModel } from "./identity";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";

// Retain the short ids emitted by the first local integration. New requests use the live catalog's
// provider-native IDs directly; this map is compatibility-only and is not a model fallback list.
const COMMAND_CODE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "kimi-k3": "moonshotai/Kimi-K3",
  "glm-5.2": "zai-org/GLM-5.2",
};

function toolResultText(content: string | OcxContentPart[]): string {
  return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
}

function wireMessages(messages: OcxMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") content.push({ type: "reasoning", text: part.thinking });
        else content.push({ type: "tool-call", toolCallId: part.id, toolName: namespacedToolName(part.namespace, part.name), input: part.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({ role: "tool", content: [{
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: namespacedToolName(message.toolNamespace, message.toolName),
        output: { type: message.isError ? "error-text" : "text", value: toolResultText(message.content) },
      }] });
      // The proprietary wire's tool-result output is text-only; image parts returned by a
      // tool (e.g. Codex view_image) cannot live inside it. Carry them in a follow-up user
      // message using the same image encoding as the user branch so the bytes reach the model.
      const images = typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image");
      if (images.length > 0) {
        out.push({ role: "user", content: images.map(part => ({ type: "image", image: (part as { imageUrl: string }).imageUrl })) });
      }
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string") content.push({ type: "text", text: message.content });
    else for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else content.push({ type: "image", image: part.imageUrl });
    }
    out.push({ role: "user", content });
  }
  return out;
}

function visibleTools(parsed: OcxParsedRequest): OcxTool[] {
  const choice = parsed.options.toolChoice;
  if (choice === "none") return [];
  const tools = parsed.context.tools ?? [];
  if (isAllowedToolChoice(choice)) {
    const allowed = new Set(choice.allowedTools);
    return tools.filter(tool => toolAllowedByChoice(tool, allowed));
  }
  if (choice && typeof choice !== "string") {
    return tools.filter(tool => tool.name === choice.name || namespacedToolName(tool.namespace, tool.name) === choice.name);
  }
  return tools;
}

function toolChoiceInstruction(parsed: OcxParsedRequest): string | undefined {
  const choice = parsed.options.toolChoice;
  if (choice === "required" || (isAllowedToolChoice(choice) && choice.mode === "required")) {
    return "Tool choice is required for this turn. Make at least one call from the advertised tool catalog before answering.";
  }
  if (choice && typeof choice !== "string" && !isAllowedToolChoice(choice)) {
    return `Tool choice is required for this turn. Call the advertised tool named ${namespacedToolName(undefined, choice.name)} before answering.`;
  }
  return undefined;
}

function wireTools(tools: OcxTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function currentWorkingDirectory(): string | undefined {
  try { return process.cwd(); } catch { return undefined; }
}

/** Cap the workspace listing so a large directory does not ship every entry name upstream. */
const MAX_WORKSPACE_STRUCTURE_ENTRIES = 64;
/** Cap how many recent commit subjects the config carries. */
const MAX_RECENT_COMMITS = 8;
/** Cap the git status text sent upstream. */
const MAX_GIT_STATUS_LENGTH = 2048;

/** Derive a bounded project slug from the working directory for the `x-project-slug` header. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 64) || "workspace";
}

interface GitWorkspaceInfo {
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
}

/** Best-effort git metadata for the upstream config contract; every read fails safe. */
function gitWorkspaceInfo(cwd: string | undefined): GitWorkspaceInfo {
  const fallback: GitWorkspaceInfo = { isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] };
  if (!cwd) return fallback;
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const root = run(["rev-parse", "--show-toplevel"]);
  if (!root) return fallback;
  return {
    isGitRepo: true,
    currentBranch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD",
    mainBranch: run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") || run(["rev-parse", "--abbrev-ref", "HEAD"]) || "",
    gitStatus: run(["status", "--porcelain"]).slice(0, MAX_GIT_STATUS_LENGTH),
    recentCommits: run(["log", "--oneline", `-${MAX_RECENT_COMMITS}`]).split("\n").filter(Boolean).slice(0, MAX_RECENT_COMMITS),
  };
}

function commandCodeConfig(cwd: string | undefined): Record<string, unknown> {
  let structure: string[] = [];
  if (cwd) {
    try {
      structure = readdirSync(cwd).filter(name => !name.startsWith(".")).slice(0, MAX_WORKSPACE_STRUCTURE_ENTRIES);
    } catch { /* workspace metadata is optional */ }
  }
  const git = gitWorkspaceInfo(cwd);
  return {
    ...(cwd ? { workingDir: cwd } : {}),
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform,
    structure,
    ...git,
  };
}

function usage(value: unknown): OcxUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const inputTokens = typeof row.inputTokens === "number" ? row.inputTokens : 0;
  const outputTokens = typeof row.outputTokens === "number" ? row.outputTokens : 0;
  const details = row.inputTokenDetails && typeof row.inputTokenDetails === "object" && !Array.isArray(row.inputTokenDetails)
    ? row.inputTokenDetails as Record<string, unknown> : {};
  const cachedInputTokens = typeof details.cacheReadTokens === "number" ? details.cacheReadTokens : undefined;
  const cacheCreationInputTokens = typeof details.cacheWriteTokens === "number" ? details.cacheWriteTokens : undefined;
  return {
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, cacheReadInputTokens: cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
}

function eventError(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  return "Command Code stream error";
}

async function*ndjson(response: Response, budget: TranslatorBudget): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("Command Code response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let bufferBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const next = buffer + decoder.decode(value, { stream: !done });
      const nextBytes = encoder.encode(next).byteLength;
      const reservation = budget.reserveTransient(nextBytes, { kind: "live_transient" });
      buffer = next;
      reservation.commitRetained();
      budget.releaseRetained(bufferBytes, { kind: "live_transient" });
      bufferBytes = nextBytes;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line) { try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* ignore non-events */ } }
        newline = buffer.indexOf("\n");
      }
      const residualBytes = encoder.encode(buffer).byteLength;
      const residualReservation = budget.reserveTransient(residualBytes, { kind: "live_transient" });
      residualReservation.commitRetained();
      budget.releaseRetained(bufferBytes, { kind: "live_transient" });
      bufferBytes = residualBytes;
      if (done) break;
    }
    const final = buffer.trim();
    if (final) { try { yield JSON.parse(final) as Record<string, unknown>; } catch { /* ignore */ } }
  } finally {
    budget.releaseRetained(bufferBytes, { kind: "live_transient" });
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

function isReasoningEffortRejection(status: number, payload: string): boolean {
  return (status === 400 || status === 422) && /reasoning[_ -]?effort|unsupported effort|invalid effort/i.test(payload);
}

function requestWithoutReasoningEffort(request: AdapterRequest): AdapterRequest | undefined {
  try {
    const body = JSON.parse(request.body) as { params?: Record<string, unknown> };
    if (!body.params?.reasoning_effort) return undefined;
    delete body.params.reasoning_effort;
    return { ...request, body: JSON.stringify(body), reasoningLog: undefined };
  } catch {
    return undefined;
  }
}

async function fetchCommandCode(request: AdapterRequest, ctx: AdapterFetchContext | undefined, executor: typeof globalThis.fetch): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Timeout elapsed", "TimeoutError")), ctx?.timeoutMs ?? 200_000);
  const callerSignal = ctx?.abortSignal ?? new AbortController().signal;
  try {
    return await executor(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.any([callerSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}

function supportedCommandCodeEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (!requested || requested === "none") return undefined;
  const supported = commandCodeReasoningEfforts(modelId) ?? configuredReasoningEfforts(provider, modelId);
  if (!supported) return undefined;
  // Command Code's official profiles describe xhigh as the CLI label that maps to
  // the wire value `max`; preserve that mapping without advertising a synthetic tier.
  const wire = requested === "xhigh" && supported.includes("max") ? "max" : requested;
  return supported.includes(wire) ? wire : undefined;
}

export function createCommandCodeAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const executor = (provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? globalThis.fetch;
  return {
    name: "command-code",
    buildRequest(parsed: OcxParsedRequest): AdapterRequest {
      if (!provider.apiKey) throw new Error("Command Code credential missing — run ocx login command-code");
      const cwd = currentWorkingDirectory();
      const tools = visibleTools(parsed);
      const toolNudge = buildNonOpenAIToolCatalogNudgeForTools(tools, parsed.options.toolChoice);
      const choiceInstruction = toolChoiceInstruction(parsed);
      const system = identifyRoutedModel([
        ...(parsed.context.systemPrompt ?? []),
        ...(toolNudge ? [toolNudge] : []),
        ...(choiceInstruction ? [choiceInstruction] : []),
      ].join("\n\n"), parsed.modelId);
      const reasoningEffort = supportedCommandCodeEffort(provider, parsed.modelId, parsed.options.reasoning);
      const body = {
        config: commandCodeConfig(cwd), memory: null, taste: null, skills: null,
        permissionMode: "standard", mode: "agent",
        params: {
          model: COMMAND_CODE_MODEL_ALIASES[parsed.modelId] ?? parsed.modelId,
          messages: wireMessages(parsed.context.messages),
          tools: wireTools(tools),
          system,
          max_tokens: parsed.options.maxOutputTokens ?? provider.defaultMaxOutputTokens ?? 64_000,
          stream: parsed.stream,
          ...(parsed.options.temperature !== undefined ? { temperature: parsed.options.temperature } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        },
      };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "cli",
        "x-command-code-version": "1.12.0",
        "x-cli-environment": "production",
        "x-taste-learning": "false",
        "x-co-flag": "false",
        "x-session-id": randomUUID(),
      };
      if (cwd) headers["x-project-slug"] = projectSlug(cwd);
      return {
        url: `${provider.baseUrl.replace(/\/$/, "")}/alpha/generate`, method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(reasoningEffort ? { reasoningLog: { effectiveEffort: reasoningEffort, wireField: "reasoning_effort" as const, wireValue: reasoningEffort } } : {}),
      };
    },
    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const response = await fetchCommandCode(request, ctx, executor);
      if (response.ok) return response;
      const currentEffort = (() => {
        try { return (JSON.parse(request.body) as { params?: { reasoning_effort?: unknown } }).params?.reasoning_effort; } catch { return undefined; }
      })();
      if (typeof currentEffort !== "string") return response;
      let body = "";
      try {
        const observed = await readBoundedResponseBody(response.clone(), { signal: ctx?.abortSignal, maxBytes: 8 * 1024 });
        if (!observed.displaySafe) return response;
        body = observed.text;
      } catch { return response; }
      if (!isReasoningEffortRejection(response.status, body)) return response;
      const modelId = (() => {
        try { return (JSON.parse(request.body) as { params?: { model?: unknown } }).params?.model; } catch { return undefined; }
      })();
      if (typeof modelId !== "string") return response;
      const refreshed = await refreshCommandCodeReasoningEfforts(modelId, executor);
      if (!refreshed || refreshed.includes(currentEffort)) return response;
      const retry = requestWithoutReasoningEffort(request);
      if (!retry) return response;
      try { void response.body?.cancel(); } catch { /* already closed */ }
      return fetchCommandCode(retry, ctx, executor);
    },
    async *parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      let sawFinish = false;
      for await (const event of ndjson(response, budget)) {
        switch (event.type) {
          case "text-delta": if (typeof event.text === "string") yield { type: "text_delta", text: event.text }; break;
          case "reasoning-delta": if (typeof event.text === "string") yield { type: "thinking_delta", thinking: event.text }; break;
          case "tool-call": {
            const id = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
            const name = typeof event.toolName === "string" ? event.toolName : "tool";
            const input = event.input ?? event.args ?? {};
            const argumentsText = typeof input === "string" ? input : JSON.stringify(input);
            yield { type: "tool_call_start", id, name };
            budget.openCall(id);
            try {
              const reservation = budget.reserveTransient(new TextEncoder().encode(argumentsText).byteLength, { kind: "tool_args", callId: id });
              reservation.commitRetained();
              yield { type: "tool_call_delta", arguments: argumentsText };
              yield { type: "tool_call_end" };
            } finally {
              budget.closeCall(id);
            }
            break;
          }
          case "finish":
            sawFinish = true;
            yield { type: "done", usage: usage(event.totalUsage), stopReason: typeof event.rawFinishReason === "string" ? event.rawFinishReason : undefined };
            break;
          case "error": yield { type: "error", message: eventError(event.error), status: 502 }; break;
        }
      }
      // A stream that ends without a finish event still needs a terminal done so the
      // server does not wait on an adapter that silently stopped emitting.
      if (!sawFinish) yield { type: "done", usage: undefined, stopReason: undefined };
    },
    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const event of this.parseStream(response, budget)) events.push(event);
      return events;
    },
  };
}
