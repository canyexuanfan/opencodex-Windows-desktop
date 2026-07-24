/**
 * /v1/live relay (issue #371).
 *
 * Codex App / ChatGPT voice (GPT‑Live / Frameless Bidi) POSTs call-create to `{base_url}/live`.
 * Under Design B injection that base_url is this proxy, so without a route the request dies on
 * the /v1/* JSON-404 guard. Voice is an OpenAI/ChatGPT surface only — routed providers cannot
 * serve it. Relay the request to the ChatGPT forward provider (or an OpenAI API-key provider)
 * and pass the response through, including the `Location` call id the client needs next.
 *
 * When the client talks to the injected `/v1` base it sends the API multipart shape even though
 * the ChatGPT forward upstream is `backend-api/codex`. In that case rewrite to the backend
 * JSON shape and `realtime/calls` path (matches openai/codex `RealtimeCallClient`).
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
  return `${baseUrl.replace(/\/v1\/?$/, "")}/v1/live`;
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
      "ChatGPT voice relay could not parse multipart /v1/live body",
    );
  }
  const sdp = form.get("sdp");
  const sessionRaw = form.get("session");
  if (typeof sdp !== "string" || typeof sessionRaw !== "string") {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay expects multipart fields sdp and session on /v1/live",
    );
  }
  let session: unknown;
  try {
    session = JSON.parse(sessionRaw);
  } catch {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay expected JSON in the multipart session field",
    );
  }
  const encoded = new TextEncoder().encode(JSON.stringify({ sdp, session }));
  return { body: encoded, contentType: "application/json" };
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
        + "but none is configured in opencodex. Routed providers cannot serve /v1/live.",
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
    const payload = await upstreamResponse.arrayBuffer();
    if (payload.byteLength > LIVE_RESPONSE_MAX_BYTES) {
      return formatErrorResponse(502, "upstream_error", `live response too large (${payload.byteLength} bytes)`);
    }
    forward?.recordOutcome?.(upstreamResponse.status);
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
