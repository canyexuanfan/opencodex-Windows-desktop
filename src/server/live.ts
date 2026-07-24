/**
 * /v1/live and /v1/realtime/calls relay (issue #371).
 *
 * Codex App / ChatGPT voice (GPT‑Live / Frameless Bidi) POSTs call-create against the injected
 * `base_url`. Under Design B that host is this proxy, so without a route the request dies on the
 * /v1/* JSON-404 guard. Voice is an OpenAI/ChatGPT surface only — routed providers cannot serve it.
 *
 * Inbound paths:
 * - `POST /v1/live` — Frameless / ChatGPT App shape against an injected `/v1` base
 * - `POST /v1/realtime/calls` — openai/codex RealtimeCallClient and the public OpenAI Realtime API
 *
 * Upstream:
 * - ChatGPT `backend-api` → JSON `{ sdp, session? }` at `{base}/realtime/calls` (multipart rewritten)
 * - OpenAI API-key provider → multipart (or raw) at `{base}/v1/realtime/calls`
 *
 * Pass the response through, including the `Location` call id the client needs next. Sideband WS
 * follow-ups for `/v1/live/{callId}` / `/v1/realtime/calls/{callId}` remain a possible later phase.
 */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import { resolveFirstUsableOpenAiSidecar, selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId } from "./responses";

/** Voice call create can wait on SDP negotiation; bound a hung upstream. */
const LIVE_UPSTREAM_TIMEOUT_MS = 120_000;
const LIVE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const LIVE_RELAY_HEADERS = ["content-type", "location"] as const;

function isChatGptBackendBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("/backend-api");
}

function keyedLiveUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1\/?$/, "")}/v1/realtime/calls`;
}

function forwardLiveUrl(baseUrl: string, usesBackendShape: boolean): string {
  const root = baseUrl.replace(/\/$/, "");
  return usesBackendShape ? `${root}/realtime/calls` : `${root}/live`;
}

async function backendJsonBodyFromApiMultipart(
  body: ArrayBuffer,
  contentType: string,
): Promise<{ body: Uint8Array; contentType: string } | Response> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay could not parse multipart call-create body",
    );
  }
  const sdp = form.get("sdp");
  if (typeof sdp !== "string") {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay expects multipart field sdp on call-create",
    );
  }
  // `session` is optional on the public Realtime calls API; omit when the client sends SDP only.
  const sessionRaw = form.get("session");
  let session: unknown | undefined;
  if (sessionRaw != null) {
    if (typeof sessionRaw !== "string") {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected a string multipart session field",
      );
    }
    try {
      session = JSON.parse(sessionRaw);
    } catch {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected JSON in the multipart session field",
      );
    }
  }
  const payload = session === undefined ? { sdp } : { sdp, session };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return { body: encoded, contentType: "application/json" };
}

/** Read an upstream body with a hard byte cap so oversized replies abort before full buffering. */
async function readUpstreamBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer | Response> {
  const stream = response.body;
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return formatErrorResponse(
          502,
          "upstream_error",
          `live response too large (${total} bytes)`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
  }
  if (chunks.length === 0) return new ArrayBuffer(0);
  if (chunks.length === 1) {
    const only = chunks[0]!;
    return only.buffer.slice(only.byteOffset, only.byteOffset + only.byteLength) as ArrayBuffer;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function handleLive(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response> {
  try {
    validateForwardAdmissionCredential(req.headers, config);
  } catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    throw err;
  }

  const inboundContentType = req.headers.get("content-type") ?? "application/octet-stream";
  let inboundBody: ArrayBuffer;
  try {
    inboundBody = await req.arrayBuffer();
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    return formatErrorResponse(
      400,
      "invalid_request_error",
      `live request body unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const candidates = selectOpenAiImagesProvider(config);
  if (candidates.forwardCandidates.length === 0 && !candidates.keyed) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in ChatGPT voice needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider), "
        + "but none is configured in opencodex. Routed providers cannot serve voice call-create.",
    );
  }

  let forward: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>> | undefined;
  let forwardAuthError: Response | undefined;
  if (candidates.forwardCandidates.length > 0) {
    try {
      forward = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, req.headers, config);
      if (forward) {
        logCtx.provider = formatCodexProviderForLog(
          forward.providerName,
          codexLogAccountId(forward.authContext),
          config,
        );
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      } else if (err instanceof CodexThreadAffinityExpiredError) {
        forwardAuthError = formatErrorResponse(
          409,
          "invalid_request_error",
          "Codex thread account affinity expired; start a new session",
        );
      } else if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog("openai", err.accountId, config);
        console.error(`[live] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        forwardAuthError = formatErrorResponse(
          401,
          "authentication_error",
          "Selected Codex account needs reauthentication",
        );
      } else if (err instanceof CodexPoolAuthenticationError) {
        forwardAuthError = formatErrorResponse(401, "authentication_error", err.message);
      } else {
        throw err;
      }
    }
  }

  const headers: Record<string, string> = {};
  let url: string;
  let outboundBody: ArrayBuffer = inboundBody;
  let outboundContentType = inboundContentType;

  if (forward) {
    const { provider } = forward;
    if (provider.headers) Object.assign(headers, provider.headers);
    for (const [name, value] of forward.headers) headers[name] = value;
    const usesBackendShape = isChatGptBackendBaseUrl(provider.baseUrl);
    url = forwardLiveUrl(provider.baseUrl, usesBackendShape);
    if (usesBackendShape && inboundContentType.toLowerCase().includes("multipart/form-data")) {
      const rewritten = await backendJsonBodyFromApiMultipart(inboundBody, inboundContentType);
      if (rewritten instanceof Response) return rewritten;
      outboundBody = rewritten.body.buffer.slice(
        rewritten.body.byteOffset,
        rewritten.body.byteOffset + rewritten.body.byteLength,
      ) as ArrayBuffer;
      outboundContentType = rewritten.contentType;
    }
  } else if (forwardAuthError) {
    return forwardAuthError;
  } else if (candidates.keyed) {
    const { provider, apiKey, providerName } = candidates.keyed;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers.authorization = `Bearer ${apiKey}`;
    logCtx.provider = providerName;
    url = keyedLiveUrl(provider.baseUrl);
  } else {
    return formatErrorResponse(
      401,
      "authentication_error",
      "voice relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
    );
  }

  headers["content-type"] = outboundContentType;
  logCtx.model = "gpt-live";

  const timeoutMs = LIVE_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("live");
  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: outboundBody,
      signal: linkedSignal.signal,
    });
    // Record every completed upstream response before body size handling so account health /
    // cooldown still updates when we reject an oversized payload.
    forward?.recordOutcome?.(upstreamResponse.status);
    const payload = await readUpstreamBodyCapped(upstreamResponse, LIVE_RESPONSE_MAX_BYTES);
    if (payload instanceof Response) return payload;
    const relayHeaders: Record<string, string> = {};
    for (const name of LIVE_RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) relayHeaders[name] = value;
    }
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      forward?.recordOutcome?.("timeout");
      return formatErrorResponse(504, "upstream_error", "live upstream timed out");
    }
    forward?.recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `live relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
