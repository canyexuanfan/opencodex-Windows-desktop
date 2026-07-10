/**
 * /v1/images/{generations,edits} relay (issue #83).
 *
 * codex-rs's standalone image_gen extension executes CLIENT-SIDE: it POSTs
 * `{base_url}/images/generations` (edits when reference images are attached) with the same
 * ChatGPT bearer auth it uses for chat. Under Design B injection base_url IS this proxy, so
 * without a route the tool died on the /v1/* JSON-404 guard. Only an OpenAI-family upstream
 * can serve these endpoints — routed providers (Cursor, Kiro, Gemini, …) have no image
 * generation surface — so the handler relays the body verbatim to the ChatGPT forward
 * provider (or an OpenAI API-key provider) and passes the response through untouched:
 * codex's images client parses `{created, data:[{b64_json}]}` strictly and Debug-prints
 * error bodies into the model-visible failure, so upstream errors must stay legible.
 */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { resolveEnvValue } from "../config";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isProxyAdmissionSecret } from "./auth-cors";
import { readJsonRequestBody } from "./request-decompress";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse, sidecarOutcomeRecorder } from "./responses";

export type ImagesEndpoint = "generations" | "edits";

/** Image generation is slow (tens of seconds); bound a hung upstream, not a working one. */
const IMAGES_UPSTREAM_TIMEOUT_MS = 300_000;

interface NamedProvider {
  name: string;
  provider: OcxProviderConfig;
}

interface ImagesUpstreamCandidates {
  /** ChatGPT passthrough — the backend codex itself would have called absent the base_url override. */
  forward?: NamedProvider;
  /** Keyed openai-responses provider (e.g. api.openai.com), whose /v1/images/* is the platform Images API. */
  keyed?: NamedProvider & { apiKey: string };
}

/**
 * Collect the upstreams that can serve /images/*. The forward provider is preferred (same
 * precedence as the vision/web-search sidecars) but only usable when the request actually
 * carries relayable ChatGPT auth — startServer auto-upserts a `chatgpt` forward entry into
 * every config, so its mere presence proves nothing about credentials.
 */
function findImagesUpstreams(config: OcxConfig): ImagesUpstreamCandidates {
  const candidates: ImagesUpstreamCandidates = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true) continue;
    if (provider.authMode === "forward") {
      candidates.forward ??= { name, provider };
      continue;
    }
    if (candidates.keyed || provider.adapter !== "openai-responses" || provider.authMode === "oauth") continue;
    const apiKey = resolveEnvValue(provider.apiKey);
    if (apiKey) candidates.keyed = { name, provider, apiKey };
  }
  return candidates;
}

export async function handleImages(
  req: Request,
  config: OcxConfig,
  endpoint: ImagesEndpoint,
  logCtx: RequestLogContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "images");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  const candidates = findImagesUpstreams(config);
  if (!candidates.forward && !candidates.keyed) {
    // 400, not 5xx: codex retries every 5xx up to 5 total attempts, and this is a permanent
    // configuration state that must surface on the first attempt.
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in image generation needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider), "
      + "but none is configured in opencodex. Routed providers cannot serve /v1/images/* — "
      + "add an OpenAI provider or disable the tool with `codex features disable image_generation`.",
    );
  }

  // Resolve forward auth first; failures are captured, not returned, so a configured keyed
  // provider can still serve the request (e.g. every pool account cooling down must not
  // 429 image_gen while api.openai.com sits idle).
  let forwardAuthHeaders: Headers | undefined;
  let forwardAuthError: Response | undefined;
  let recordOutcome: ReturnType<typeof sidecarOutcomeRecorder>;
  if (candidates.forward) {
    try {
      const authCtx = await resolveCodexAuthContext(req.headers, config);
      if (!isCodexAuthContextUsable(authCtx, config)) {
        forwardAuthError = formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      } else {
        // Forwarded caller auth, overridden by the routed pool account's token when one is selected.
        const authHeaders = headersForCodexAuthContext(req.headers, authCtx);
        const bearer = authHeaders.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        // A caller may authenticate to the proxy itself with `Authorization: Bearer <admission
        // token>` (non-loopback binds); that secret must never be relayed to chatgpt.com.
        if (bearer && isProxyAdmissionSecret(bearer, config)) authHeaders.delete("authorization");
        // Only relay through the ChatGPT backend when there is a bearer to relay: startServer
        // auto-upserts the `chatgpt` provider, so an unauthenticated request must not be bounced
        // off chatgpt.com when a keyed OpenAI provider (or an honest error) serves it better.
        if (authHeaders.get("authorization")) {
          forwardAuthHeaders = authHeaders;
          recordOutcome = sidecarOutcomeRecorder(config, authCtx);
          logCtx.provider = formatCodexProviderForLog(candidates.forward.name, codexLogAccountId(authCtx), config);
        }
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      } else if (err instanceof CodexThreadAffinityExpiredError) {
        forwardAuthError = formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
      } else if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog(candidates.forward.name, err.accountId, config);
        console.error(`[images] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        forwardAuthError = formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      } else {
        throw err;
      }
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  if (forwardAuthHeaders && candidates.forward) {
    const { provider } = candidates.forward;
    if (provider.headers) Object.assign(headers, provider.headers);
    for (const [name, value] of forwardAuthHeaders) headers[name] = value;
    // The ChatGPT codex backend takes bare paths (matches the adapter's `${baseUrl}/responses`).
    url = `${provider.baseUrl}/images/${endpoint}`;
  } else if (candidates.keyed) {
    const { provider, apiKey, name } = candidates.keyed;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers["authorization"] = `Bearer ${apiKey}`;
    logCtx.provider = name;
    // Keyed providers tolerate baseUrl with or without /v1 (mirrors openai-responses.ts).
    url = `${provider.baseUrl.replace(/\/v1\/?$/, "")}/v1/images/${endpoint}`;
  } else if (forwardAuthError) {
    return forwardAuthError;
  } else {
    return formatErrorResponse(
      401,
      "authentication_error",
      "image generation relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
    );
  }

  const timeoutMs = config.images?.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("images");
  try {
    const upstreamResponse = await fetchWithResetRetry(
      () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
      }),
      { abortSignal: linkedSignal.signal, label: "images-relay" },
    );
    // Buffer rather than stream: the payload is one JSON document (base64 image, a few MB),
    // and buffering keeps the timeout window covering the whole exchange.
    const payload = await upstreamResponse.arrayBuffer();
    recordOutcome?.(upstreamResponse.status);
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    // Client cancel first: it aborts the linked signal too, and must not be logged as an
    // upstream failure (499 maps to client_closed_request in the request log).
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", `image ${endpoint} request canceled by client`);
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      recordOutcome?.("timeout");
      // codex retries 5xx up to 4 more times; a retried 504 is acceptable for a transient hang.
      return formatErrorResponse(504, "upstream_error", `image ${endpoint} upstream timed out`);
    }
    recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `image ${endpoint} relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
