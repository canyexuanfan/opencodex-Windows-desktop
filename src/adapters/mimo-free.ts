import { createHash } from "node:crypto";
import os from "node:os";
import type { OcxProviderConfig, OcxParsedRequest } from "../types";
import { createOpenAIChatAdapter } from "./openai-chat";
import type { ProviderAdapter, AdapterRequest } from "./base";

const BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
export const MIMO_CHAT_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";

/**
 * Anti-abuse gate: the free chat endpoint returns 403 "Illegal access" unless
 * a system message contains this exact string as a substring.
 */
export const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

// Chrome-like User-Agent required by the upstream anti-abuse gate.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const JWT_FALLBACK_TTL_MS = 3_000_000; // 50 min
const JWT_EXPIRY_BUFFER_MS = 300_000;  // 5 min early refresh

// In-process JWT cache -- survives across requests, reset on restart.
let cachedJwt: string | null = null;
let jwtExpiresAt = 0;

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

/** SHA-256 fingerprint of stable machine attributes; stable per machine, not a secret. */
export function generateMimoFingerprint(): string {
  let username = "unknown-user";
  try { username = os.userInfo().username; } catch { /* ignore */ }
  const cpu = (os.cpus()[0]?.model ?? "unknown-cpu").trim();
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
  return createHash("sha256").update(seed).digest("hex");
}

function parseJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString()) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch { /* ignore */ }
  return Date.now() + JWT_FALLBACK_TTL_MS;
}

export function resetMimoJwtCache(): void {
  cachedJwt = null;
  jwtExpiresAt = 0;
}

async function fetchJwt(): Promise<string> {
  const response = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": randomUserAgent(),
    },
    body: JSON.stringify({ client: generateMimoFingerprint() }),
  });
  if (!response.ok) {
    throw new Error(`MiMo bootstrap failed: ${response.status}`);
  }
  const data = await response.json() as { jwt?: string };
  if (!data.jwt) throw new Error("MiMo bootstrap returned no JWT");
  return data.jwt;
}

export async function getMimoJwt(): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }
  const jwt = await fetchJwt();
  cachedJwt = jwt;
  jwtExpiresAt = parseJwtExp(jwt);
  return jwt;
}

/**
 * Idempotently prepend the MiMo anti-abuse system marker if it is not already present.
 * The marker must appear in a system message; we prepend one if the request has none with it.
 */
export function injectMimoSystemMarker(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const parsed = body as Record<string, unknown>;
  const messages = parsed["messages"];
  if (!Array.isArray(messages)) return body;
  const hasMarker = messages.some(
    (m): m is { role: string; content: string } =>
      m !== null &&
      typeof m === "object" &&
      (m as Record<string, unknown>)["role"] === "system" &&
      typeof (m as Record<string, unknown>)["content"] === "string" &&
      ((m as Record<string, unknown>)["content"] as string).includes(MIMO_SYSTEM_MARKER),
  );
  if (hasMarker) return body;
  return { ...parsed, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

/**
 * Creates the MiMo Free adapter. Wraps openai-chat's request builder to inject:
 *   1. JWT from the bootstrap endpoint (cached, auto-refreshed).
 *   2. Anti-abuse system marker in the request body.
 *   3. Required headers (User-Agent, X-Mimo-Source, x-session-affinity).
 * On 401/403, flushes the JWT cache and retries once via fetchResponse.
 */
export function createMimoFreeAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const base = createOpenAIChatAdapter(provider);
  // Per-adapter session-affinity id (random, per process instance).
  const sessionId = `ses_${Math.random().toString(36).slice(2, 26)}`;

  return {
    ...base,
    name: "mimo-free",

    async buildRequest(parsed: OcxParsedRequest): Promise<AdapterRequest> {
      const jwt = await getMimoJwt();

      // Let the base adapter build the wire body (handles reasoning, tools, etc.)
      // but override the URL and headers after.
      const baseReq = base.buildRequest(parsed) as AdapterRequest;
      const baseBody = JSON.parse(baseReq.body as string) as unknown;
      const markedBody = injectMimoSystemMarker(baseBody);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
        "X-Mimo-Source": "mimocode-cli-free",
        "User-Agent": randomUserAgent(),
        "x-session-affinity": sessionId,
        "Accept": parsed.stream ? "text/event-stream" : "application/json",
      };

      return {
        url: MIMO_CHAT_URL,
        method: "POST",
        headers,
        body: JSON.stringify(markedBody),
      };
    },

    async fetchResponse(request: AdapterRequest, ctx): Promise<Response> {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: request.body,
        signal: ctx?.abortSignal,
      });

      // On auth failure, flush JWT cache and retry once with a fresh token.
      if (response.status === 401 || response.status === 403) {
        resetMimoJwtCache();
        const freshJwt = await getMimoJwt();
        const retryHeaders = {
          ...(request.headers as Record<string, string>),
          "Authorization": `Bearer ${freshJwt}`,
        };
        return fetch(request.url, {
          method: request.method,
          headers: retryHeaders,
          body: request.body,
          signal: ctx?.abortSignal,
        });
      }

      return response;
    },
  };
}
