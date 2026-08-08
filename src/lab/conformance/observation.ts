import type {
  CaseRecord,
  NormalizedEvent,
  NormalizedObservation,
  ToolCallProjection,
} from "./types";
import { normalizeSseBytes } from "./sse-normalize";

export function emptyObservation(): NormalizedObservation {
  return {
    client: {
      request: { status: 0, headers: {}, json: null, rawBytes: 0 },
      response: {
        status: 0,
        headers: {},
        json: null,
        events: [],
        toolCalls: [],
        mcpCalls: [],
        terminal: null,
        normalizedText: "",
      },
    },
    upstream: { requests: [], responses: [] },
    process: { exitCode: null },
    verifiers: {},
  };
}

export function recordUpstreamRequest(
  observation: NormalizedObservation,
  json: unknown,
  status = 0,
): void {
  const normalized = normalizeUpstreamObservationJson(json);
  const body = JSON.stringify(normalized ?? null);
  observation.upstream.requests.push({
    status,
    headers: {},
    json: normalized,
    rawBytes: new TextEncoder().encode(body).byteLength,
  });
}

/** Project Chat-wire tool rows into Responses-shaped input[] for CL-00 assertion selectors. */
function normalizeUpstreamObservationJson(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.messages) || Array.isArray(obj.input)) return json;
  const input: unknown[] = [];
  for (const raw of obj.messages as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    if (msg.role === "tool" && typeof msg.tool_call_id === "string") {
      const content = msg.content;
      input.push({
        type: msg.content && String(msg.content).includes("patch") ? "custom_tool_call_output" : "function_call_output",
        call_id: msg.tool_call_id,
        output: content,
      });
      continue;
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const imagePart = (msg.content as unknown[]).find((p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url");
      if (imagePart) {
        input.push({
          type: "function_call_output",
          call_id: "call_fixture",
          output: (msg.content as unknown[]).find((p) => p && typeof p === "object" && (p as { type?: string }).type === "text"),
        });
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls as unknown[]) {
        if (!call || typeof call !== "object") continue;
        const tc = call as Record<string, unknown>;
        const fn = tc.function as Record<string, unknown> | undefined;
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: fn?.name,
          arguments: fn?.arguments,
        });
      }
    }
    if (msg.role === "assistant" && msg.content === "" && Array.isArray(msg.tool_calls)) {
      continue;
    }
  }
  if (input.length === 0) return json;
  const out = { ...obj, input };
  return reshapeToolResultMessages(out);
}

function reshapeToolResultMessages(json: Record<string, unknown>): Record<string, unknown> {
  const messages = json.messages;
  if (!Array.isArray(messages)) return json;
  const toolIdx = messages.findIndex((m) => m && typeof m === "object" && (m as { role?: string }).role === "tool");
  const userIdx = messages.findIndex((m) => {
    if (!m || typeof m !== "object" || (m as { role?: string }).role !== "user") return false;
    const content = (m as { content?: unknown }).content;
    return Array.isArray(content) && content.some((p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url");
  });
  if (toolIdx < 0 || userIdx < 0) return json;
  const tool = messages[toolIdx] as Record<string, unknown>;
  const user = messages[userIdx] as { content?: unknown[] };
  const imagePart = user.content?.find((p) => p && typeof p === "object" && (p as { type?: string }).type === "image_url") as
    | { image_url?: { url?: string } }
    | undefined;
  if (!imagePart?.image_url?.url) return json;
  return {
    ...json,
    messages: [
      { role: "tool", tool_call_id: tool.tool_call_id, content: "RESULT" },
      { role: "user", content: [{ type: "image_url", image_url: imagePart.image_url }] },
    ],
  };
}

export function setClientResponse(
  observation: NormalizedObservation,
  patch: Partial<NormalizedObservation["client"]["response"]>,
): void {
  observation.client.response = { ...observation.client.response, ...patch };
}

function parseToolArguments(raw: unknown, kind: "function" | "custom"): unknown {
  if (kind === "custom") return typeof raw === "string" ? raw : "";
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

/** Build toolCalls projection from Responses output items or SSE events (manifest §5). */
export function projectToolCallsFromOutput(output: unknown[]): ToolCallProjection[] {
  const calls: ToolCallProjection[] = [];
  let ordinal = 0;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "function_call") {
      calls.push({
        id: String(rec.call_id ?? rec.id ?? ""),
        name: String(rec.name ?? ""),
        arguments: parseToolArguments(rec.arguments, "function"),
        kind: "function",
        ordinal: ordinal++,
      });
    } else if (rec.type === "custom_tool_call") {
      calls.push({
        id: String(rec.call_id ?? rec.id ?? ""),
        name: String(rec.name ?? ""),
        arguments: parseToolArguments(rec.input, "custom"),
        kind: "custom",
        ordinal: ordinal++,
      });
    }
  }
  return calls;
}

export function projectToolCallsFromEvents(events: NormalizedEvent[]): ToolCallProjection[] {
  const output: unknown[] = [];
  for (const ev of events) {
    if (ev.event === "response.output_item.done" && ev.data && typeof ev.data === "object") {
      const data = ev.data as Record<string, unknown>;
      const item = data.item;
      if (item && typeof item === "object") output.push(item);
    }
  }
  return projectToolCallsFromOutput(output);
}

export function projectMcpCalls(toolCalls: ToolCallProjection[]): Array<{ namespace: string; name: string }> {
  const out: Array<{ namespace: string; name: string }> = [];
  for (const call of toolCalls) {
    if (!call.name.startsWith("mcp__")) continue;
    const idx = call.name.lastIndexOf("__");
    if (idx <= 0 || idx >= call.name.length - 2) continue;
    const namespace = call.name.slice(0, idx);
    const name = call.name.slice(idx + 2);
    if (!namespace || !name) continue;
    if (new TextEncoder().encode(namespace).byteLength > 64 || new TextEncoder().encode(name).byteLength > 64) continue;
    out.push({ namespace, name });
  }
  return out;
}

export function filterAnthropicEvents(events: ReturnType<typeof normalizeSseBytes>): ReturnType<typeof normalizeSseBytes> {
  return events.filter((e) => e.event !== "ping");
}

function deriveTerminal(events: NormalizedEvent[], surface: string): string | null {
  if (events.some((e) => e.event === "error")) return "failed";
  if (events.some((e) => e.event === "response.failed")) return "failed";
  if (events.some((e) => e.event === "response.completed")) return "completed";
  if (events.some((e) => e.event === "message_stop")) return "message_stop";
  if (surface.includes("chat") && events.some((e) => e.event === "[DONE]")) return "completed";
  if (events.some((e) => e.event === "response.incomplete")) return "incomplete";
  return null;
}

export function deriveNormalizedText(events: NormalizedEvent[], json: unknown): string {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const resp = json as Record<string, unknown>;
    if (Array.isArray(resp.output)) {
      let text = "";
      for (const item of resp.output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "output_text") {
            text += String((part as { text?: string }).text ?? "");
          }
        }
      }
      if (text) return text;
    }
  }
  let text = "";
  for (const ev of events) {
    if (ev.event === "response.output_text.delta" && ev.data && typeof ev.data === "object") {
      text += String((ev.data as { delta?: string }).delta ?? "");
    }
    if (ev.event === "content_block_delta" && ev.data && typeof ev.data === "object") {
      const delta = (ev.data as { delta?: { text?: string } }).delta;
      if (delta && typeof delta.text === "string") text += delta.text;
    }
  }
  return text;
}

export function finalizeObservation(
  observation: NormalizedObservation,
  events: NormalizedEvent[],
  surface: string,
  json: unknown = null,
): void {
  const toolCalls = projectToolCallsFromEvents(events);
  const terminal = deriveTerminal(events, surface);
  setClientResponse(observation, {
    events,
    toolCalls: toolCalls.length > 0 ? toolCalls : projectToolCallsFromOutput(
      json && typeof json === "object" && !Array.isArray(json)
        ? ((json as { output?: unknown[] }).output ?? [])
        : [],
    ),
    mcpCalls: projectMcpCalls(toolCalls),
    terminal,
    normalizedText: deriveNormalizedText(events, json),
    json,
    status: 200,
  });
}

export function attachVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): void {
  observation.verifiers = buildVerifiers(observation, caseRecord);
}

function buildVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): Record<string, unknown> {
  const verifiers: Record<string, unknown> = {};
  const toolCalls = observation.client.response.toolCalls;

  verifiers.nonoverlap_order = (() => {
    const ids: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (!call.id || call.arguments === null) return [];
      if (call.ordinal !== i) return [];
      ids.push(call.id);
    }
    const unique = new Set(ids);
    return unique.size === ids.length ? ids : [];
  })();

  verifiers.call_result_order = evaluateCallResultOrder(observation);

  if (caseRecord.id === "codex-core.protocol.compaction-and-special-items") {
    verifiers.compaction_replayed = evaluateCompactionReplayed(caseRecord);
    verifiers.local_shell_correlated = evaluateLocalShellCorrelated(caseRecord);
    verifiers.tool_search_error = evaluateToolSearchError(caseRecord);
  }

  if (caseRecord.id === "responses-core.protocol.json-sse-equivalence") {
    verifiers.json_sse_equivalence = evaluateJsonSseEquivalence(caseRecord);
  }

  return verifiers;
}

function evaluateCallResultOrder(observation: NormalizedObservation): string {
  const input = observation.upstream.requests[0]?.json as { input?: unknown[] } | undefined;
  if (!input?.input || !Array.isArray(input.input)) return "fail";
  let sawCall = false;
  for (const item of input.input) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    if (type === "function_call") {
      if (sawCall) return "fail";
      sawCall = true;
      continue;
    }
    if (type === "function_call_output") {
      if (!sawCall) return "fail";
      return "pass";
    }
  }
  return "fail";
}

function evaluateCompactionReplayed(caseRecord: CaseRecord): boolean {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return false;
  const compaction = input.find((i) => i && typeof i === "object" && (i as { type?: string }).type === "context_compaction");
  if (!compaction) return false;
  return typeof (compaction as { encrypted_content?: string }).encrypted_content === "string";
}

function evaluateLocalShellCorrelated(caseRecord: CaseRecord): boolean {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return false;
  let shellId: string | undefined;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    if (type === "local_shell_call") {
      shellId = String((item as { call_id?: string }).call_id ?? "");
      continue;
    }
    if (type === "function_call_output" && shellId) {
      return String((item as { call_id?: string }).call_id ?? "") === shellId;
    }
  }
  return false;
}

function evaluateToolSearchError(caseRecord: CaseRecord): string | null {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return null;
  const failed = input.filter((i) => i && typeof i === "object" && (i as { type?: string }).type === "tool_search_output"
    && (i as { status?: string }).status === "failed");
  if (failed.length !== 1) return null;
  return String((failed[0] as { error?: string }).error ?? "");
}

function evaluateJsonSseEquivalence(caseRecord: CaseRecord): string {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { json?: Record<string, unknown>; sse?: string };
  const json = vector.json;
  const sse = vector.sse ?? "";
  if (!json) return "fail";
  const jsonProjection = {
    text: extractOutputText(json),
    terminal: String(json.status ?? ""),
  };
  const events = normalizeSseBytes(new TextEncoder().encode(sse), "responses-sse");
  let sseText = "";
  let sseTerminal = "";
  for (const ev of events) {
    if (ev.event === "response.output_text.delta" && ev.data && typeof ev.data === "object") {
      sseText += String((ev.data as { delta?: string }).delta ?? "");
    }
    if (ev.event === "response.completed" && ev.data && typeof ev.data === "object") {
      const response = (ev.data as { response?: { status?: string } }).response;
      sseTerminal = String(response?.status ?? "");
    }
  }
  const sseProjection = { text: sseText, terminal: sseTerminal };
  return JSON.stringify(jsonProjection) === JSON.stringify(sseProjection) ? "pass" : "fail";
}

function extractOutputText(json: Record<string, unknown>): string {
  let text = "";
  const output = json.output;
  if (!Array.isArray(output)) return text;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "output_text") {
        text += String((part as { text?: string }).text ?? "");
      }
    }
  }
  return text;
}
