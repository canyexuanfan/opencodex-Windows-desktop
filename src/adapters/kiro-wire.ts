import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { OcxParsedRequest } from "../types";

let cachedFp: string | undefined;

export function fingerprint(): string {
  if (cachedFp) return cachedFp;
  try {
    cachedFp = createHash("sha256").update(`${hostname()}-${userInfo().username}-kiro-ocx`).digest("hex");
  } catch {
    cachedFp = createHash("sha256").update("default-kiro-ocx").digest("hex");
  }
  return cachedFp;
}

export function osTag(): string {
  const p = process.platform;
  if (p === "darwin") return "macos#24.0.0";
  if (p === "win32") return "win32#10.0.26100";
  return "linux#6.8.0";
}

/** registry model id -> CodeWhisperer model id (only "kiro-auto" is prefixed). */
export function mapModelId(id: string): string {
  return id === "kiro-auto" ? "auto" : id.replace(/^kiro-/, "");
}

/** CodeWhisperer toolUseId constraint: ^[a-zA-Z0-9_-]{1,64}$ */
export function normalizeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 64 ? s.slice(0, 64) : s;
}

export function fallbackToolUseId(): string {
  return `toolu_${randomUUID().slice(0, 8)}`;
}

export function invocationId(): string {
  return randomUUID();
}

export function stableConversationId(parsed: OcxParsedRequest): string {
  const msgs = parsed.context.messages;
  if (!msgs || msgs.length === 0) return randomUUID().slice(0, 16);
  const key = (msgs.length <= 3 ? msgs : [...msgs.slice(0, 3), msgs[msgs.length - 1]])
    .map(m => `${m.role}:${JSON.stringify((m as { content?: unknown }).content ?? "").slice(0, 100)}`)
    .join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
