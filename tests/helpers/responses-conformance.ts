import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

/**
 * Shared harness for Responses tool round-trip conformance
 * (devlog/_plan/260813_routed_tool_discovery_profiles/030-034).
 *
 * Every existing tool test re-implements `replay` and `collectSse` locally, which is why the
 * streaming and non-streaming paths have never been compared against each other on a common
 * shape: each test only ever looked at one of them. This module exists so one fixture can be
 * pushed through BOTH bridges and normalized into a single comparable structure.
 */

export async function* replay(events: readonly AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

export interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

export async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

/** The tool-bearing fields both transports must agree on, in output order. */
export interface NormalizedToolItem {
  type: string;
  name?: string;
  call_id?: string;
  /** `arguments` for function/tool_search, `input` for custom — normalized to one field. */
  payload?: string;
  status?: string;
}

function normalizeItem(item: Record<string, unknown>): NormalizedToolItem {
  const payload = typeof item.arguments === "string"
    ? item.arguments
    : typeof item.input === "string" ? item.input : undefined;
  return {
    type: String(item.type ?? ""),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
  };
}

type BridgeMaps = [
  toolNsMap?: Map<string, { namespace: string; name: string }>,
  freeformToolNames?: Set<string>,
  toolSearchToolNames?: Set<string>,
];

/**
 * Tool items from the streamed transport, read from `response.completed`.
 *
 * Deliberately NOT read from `output_item.done` frames: the completed snapshot is what a
 * client that reconnects or ignores deltas actually sees, so it is the honest counterpart to
 * the non-streaming body.
 */
export async function streamedToolItems(
  events: readonly AdapterEvent[],
  modelId: string,
  ...maps: BridgeMaps
): Promise<NormalizedToolItem[]> {
  const frames = await collectSse(bridgeToResponsesSSE(replay(events), modelId, ...maps));
  const completed = frames.find(frame => frame.event === "response.completed");
  const response = completed?.data.response as Record<string, unknown> | undefined;
  const output = Array.isArray(response?.output) ? response.output as Record<string, unknown>[] : [];
  return output.filter(item => String(item.type ?? "").includes("call")).map(normalizeItem);
}

/** Tool items from the non-streaming transport. */
export function jsonToolItems(
  events: readonly AdapterEvent[],
  modelId: string,
  options?: Parameters<typeof buildResponseJSON>[2],
): NormalizedToolItem[] {
  const body = buildResponseJSON([...events], modelId, options);
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  return output.filter(item => String(item.type ?? "").includes("call")).map(normalizeItem);
}

/** All frame event names in order — for delta-level behavior a snapshot cannot show. */
export async function streamedEventNames(
  events: readonly AdapterEvent[],
  modelId: string,
  ...maps: BridgeMaps
): Promise<string[]> {
  const frames = await collectSse(bridgeToResponsesSSE(replay(events), modelId, ...maps));
  return frames.map(frame => frame.event ?? "");
}
