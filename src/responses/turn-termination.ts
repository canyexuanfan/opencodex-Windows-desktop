import { createHash } from "node:crypto";
import type { OcxAssistantMessage, OcxMessage, OcxParsedRequest } from "../types";

const DELIVERED_FINAL_ANSWER_TTL_MS = 60 * 60 * 1_000;
const DELIVERED_FINAL_ANSWER_MAX_ENTRIES = 1_024;

interface DeliveredFinalAnswerRecord {
  fingerprint: string;
  createdAt: number;
}

const scopesByRequest = new WeakMap<OcxParsedRequest, string>();
const deliveredFinalAnswers = new Map<string, DeliveredFinalAnswerRecord>();

function pruneDeliveredFinalAnswers(at = Date.now()): void {
  for (const [scope, record] of deliveredFinalAnswers) {
    if (at - record.createdAt > DELIVERED_FINAL_ANSWER_TTL_MS) deliveredFinalAnswers.delete(scope);
  }
  while (deliveredFinalAnswers.size > DELIVERED_FINAL_ANSWER_MAX_ENTRIES) {
    const oldest = deliveredFinalAnswers.keys().next().value;
    if (oldest === undefined) break;
    deliveredFinalAnswers.delete(oldest);
  }
}

function textFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assistantText(message: OcxAssistantMessage): string | undefined {
  if (message.content.some(part => part.type === "toolCall")) return undefined;
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("");
  return text.trim().length > 0 ? text : undefined;
}

function deliveredFinalAnswerText(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as { type?: unknown; role?: unknown; phase?: unknown; content?: unknown };
    if (message.type !== "message" || message.role !== "assistant" || message.phase !== "final_answer") continue;
    if (!Array.isArray(message.content)) return undefined;
    const text = message.content
      .filter(part => !!part && typeof part === "object" && !Array.isArray(part)
        && (part as { type?: unknown }).type === "output_text"
        && typeof (part as { text?: unknown }).text === "string")
      .map(part => (part as { text: string }).text)
      .join("");
    return text.trim().length > 0 ? text : undefined;
  }
  return undefined;
}

/** Bind the normalized per-conversation digest without adding proxy-private fields to the wire body. */
export function bindTurnTerminationScope(parsed: OcxParsedRequest, scope: string | undefined): void {
  // Only the normalized log-conversation digest may key this process-wide map. Refusing any raw
  // fallback prevents a future caller from retaining a client header or account identifier here.
  if (!scope || !/^[0-9a-f]{32}$/.test(scope)) return;
  scopesByRequest.set(parsed, scope);
}

/** Remember only a final-answer message the proxy actually emitted for this exact conversation. */
export function rememberDeliveredFinalAnswer(parsed: OcxParsedRequest, response: unknown): void {
  const scope = scopesByRequest.get(parsed);
  if (!scope) return;
  const text = deliveredFinalAnswerText(response);
  if (!text) return;
  const at = Date.now();
  pruneDeliveredFinalAnswers(at);
  // Refresh insertion order so cap eviction removes the least recently delivered conversation.
  deliveredFinalAnswers.delete(scope);
  deliveredFinalAnswers.set(scope, { fingerprint: textFingerprint(text), createdAt: at });
  pruneDeliveredFinalAnswers(at);
}

/**
 * Match only when the delivered assistant answer is still the trailing content-bearing message.
 * A later user/tool-result message is new work and must reach the provider, even though every
 * legitimate next turn necessarily contains such a message somewhere in its history.
 */
export function hasRecordedTrailingDeliveredFinalAnswer(
  parsed: OcxParsedRequest,
  messages: readonly OcxMessage[],
): boolean {
  const scope = scopesByRequest.get(parsed);
  if (!scope) return false;
  pruneDeliveredFinalAnswers();
  const record = deliveredFinalAnswers.get(scope);
  if (!record) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") return false;
    const text = assistantText(message as OcxAssistantMessage);
    if (text === undefined) {
      if ((message as OcxAssistantMessage).content.some(part => part.type === "toolCall")) return false;
      continue;
    }
    return textFingerprint(text) === record.fingerprint;
  }
  return false;
}
