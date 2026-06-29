import { kiroTruncationReason } from "./kiro-truncation";

export interface ParsedKiroEvent {
  type: "content" | "tool_start" | "tool_input" | "tool_stop" | "truncation" | "usage" | "context_usage";
  data?: string;
  contextUsagePercentage?: number;
  usage?: unknown;
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
  const truncationReason = kiroTruncationReason(parsed);
  if (truncationReason) return { type: "truncation", data: truncationReason };
  if ("usage" in parsed) return { type: "usage", usage: parsed.usage };
  if (typeof parsed.contextUsagePercentage === "number" && Number.isFinite(parsed.contextUsagePercentage)) {
    return { type: "context_usage", contextUsagePercentage: parsed.contextUsagePercentage };
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
  if (name !== undefined) return { type: "tool_start", name, toolUseId };
  return null;
}
