/**
 * Claude inbound debug capture (devlog/260711_claude_inbound/130 B1).
 *
 * Opt-in ring (last 20) of ALLOWLIST SCALARS from inbound Anthropic requests so the
 * user can watch live what Claude Desktop/Code actually sends per effort-slider
 * position (thinking.type / output_config.effort) and whether metadata.user_id
 * exists (prompt-cache affinity, H1/H2).
 *
 * Privacy contract (audit 133 R1#6/R2#3): no prompt text, no raw objects, no stable
 * hashes. The only identity-ish values are 8-char HMAC tags salted with a
 * process-random key — comparable for equality WITHIN one proxy run, useless as a
 * cross-run fingerprint. Capture is gated on the `claude` debug flag and the ring is
 * cleared when the flag turns off.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isClaudeDebugEnabled } from "../lib/debug-settings";

export interface ClaudeInboundDebugEntry {
  at: number;
  endpoint: "messages" | "count_tokens";
  model: string;
  resolvedModel?: string;
  stream?: boolean;
  maxTokens?: number;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  outputConfigEffort?: string;
  metadataKeys?: string[];
  hasMetadataUserId: boolean;
  hasSystem: boolean;
  /** Raw anthropic-beta header (comma list) — carries context-1m / effort betas. */
  anthropicBeta?: string;
  /** Ephemeral equality tags (process-salted HMAC, 8 chars) — run-local identity only. */
  userIdTag?: string;
  systemTag?: string;
}

const RING_LIMIT = 20;
const ring: ClaudeInboundDebugEntry[] = [];
const salt = randomBytes(16).toString("hex");
let lastEnabled = false;

function tag(value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 8);
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function systemText(system: unknown): string | undefined {
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  if (Array.isArray(system)) {
    const parts = system
      .filter((b): b is Rec => isRec(b) && b.type === "text" && typeof b.text === "string")
      .map(b => b.text as string);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

/** Record one inbound request. No-op (and ring flush) when the claude debug flag is off. */
export function captureClaudeInbound(
  endpoint: "messages" | "count_tokens",
  body: unknown,
  resolvedModel?: string,
  anthropicBeta?: string,
): void {
  const enabled = isClaudeDebugEnabled();
  if (!enabled) {
    if (lastEnabled) ring.length = 0; // flag turned off: drop captured entries
    lastEnabled = false;
    return;
  }
  lastEnabled = true;
  if (!isRec(body)) return;
  const thinking = isRec(body.thinking) ? body.thinking : undefined;
  const outputConfig = isRec(body.output_config) ? body.output_config : undefined;
  const metadata = isRec(body.metadata) ? body.metadata : undefined;
  const userId = metadata && typeof metadata.user_id === "string" ? metadata.user_id : undefined;
  const system = systemText(body.system);
  const entry: ClaudeInboundDebugEntry = {
    at: Date.now(),
    endpoint,
    model: typeof body.model === "string" ? body.model : "unknown",
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
    ...(thinking && typeof thinking.type === "string" ? { thinkingType: thinking.type } : {}),
    ...(thinking && typeof thinking.budget_tokens === "number" ? { thinkingBudgetTokens: thinking.budget_tokens } : {}),
    ...(outputConfig && typeof outputConfig.effort === "string" ? { outputConfigEffort: outputConfig.effort } : {}),
    ...(metadata ? { metadataKeys: Object.keys(metadata) } : {}),
    hasMetadataUserId: userId !== undefined,
    hasSystem: system !== undefined,
    ...(anthropicBeta ? { anthropicBeta } : {}),
    ...(userId !== undefined ? { userIdTag: tag(userId) } : {}),
    ...(system !== undefined ? { systemTag: tag(system) } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_LIMIT) ring.shift();
}

/** Newest-first snapshot for /api/claude/inbound-debug. */
export function getClaudeInboundDebugEntries(): ClaudeInboundDebugEntry[] {
  return [...ring].reverse();
}

/** Test isolation / explicit clear. */
export function clearClaudeInboundDebug(): void {
  ring.length = 0;
  lastEnabled = false;
}
