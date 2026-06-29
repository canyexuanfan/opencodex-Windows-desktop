import { createHash } from "node:crypto";
import type { OcxContentPart, OcxParsedRequest } from "../types";

/** Antigravity request User-Agent (overridable). Mirrors the Antigravity desktop client UA. */
export const ANTIGRAVITY_REQUEST_UA = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT || "antigravity";

function firstUserText(parsed: OcxParsedRequest): string | undefined {
  for (const msg of parsed.context.messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    const first = (msg.content as OcxContentPart[]).find(p => p.type === "text" && typeof p.text === "string");
    if (first && first.type === "text") return first.text;
  }
  return undefined;
}

/**
 * Deterministic Cloud Code Assist session id from the first user message text. Mirrors
 * CLIProxyAPI `generateStableSessionID`: sha256(firstUserText) → BigEndian uint64 masked with
 * 0x7FFFFFFFFFFFFFFF, prefixed with "-". Falls back to a random "-<digits>" id when there is no text.
 */
export function antigravitySessionId(parsed: OcxParsedRequest): string {
  const text = firstUserText(parsed);
  if (!text) return `-${Math.floor(Math.random() * 9e18).toString()}`;
  const digest = createHash("sha256").update(text, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}
