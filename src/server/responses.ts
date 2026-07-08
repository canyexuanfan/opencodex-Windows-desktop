import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  getConfigPath,
  resolveEnvValue,
} from "../config";
import { parseRequest } from "../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../responses/compaction";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseConversationId, rememberResponseState } from "../responses/state";
import { routeModel } from "../router";
import { modelInList, namespacedToolName } from "../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import {
  getOAuthCredentialProjectId,
  getValidAccessToken,
  UnsupportedOAuthProviderError,
} from "../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch } from "../web-search";
import { describeImagesInPlace, planVisionSidecar, stripImagesInPlace } from "../vision";
import { createAdapterEventQueue } from "../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../codex/routing";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { isUsageDebugEnabled } from "../usage/debug";
import { readJsonRequestBody, UnsupportedContentEncodingError } from "./request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "./adapter-resolve";
import { hasKeyPoolFailover, rotateKeyOn429 } from "../providers/key-failover";
import type { WsData } from "./ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "./lifecycle";
import { redactSecretString } from "../lib/redact";
import {
  catalogModelSupportsServiceTier,
  inspectResponseLogJson,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  type RequestLogContext,
} from "./request-log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "./relay";

export function buildToolBridgeMaps(parsed: OcxParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
    if (t.freeform) freeformToolNames.add(t.name);
    if (t.toolSearch) toolSearchToolNames.add(t.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export function sidecarOutcomeRecorder(config: OcxConfig, authCtx: CodexAuthContext): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome)
    : undefined;
}

/** Account id to attribute log labels / upstream outcomes to (pool + rotation-injected main). */
export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

export function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): ((status: ResponsesTerminalStatus) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return status => recordCodexUpstreamOutcome(config, authCtx.accountId, status === "completed" ? 200 : 502);
}

export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: {
    forceEmptyResponseId?: boolean;
    abortSignal?: AbortSignal;
    authContext?: CodexAuthContext;
    selectedForwardHeaders?: Headers;
    recordTerminalOutcomes?: boolean;
    setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus) => void) | undefined) => void;
    onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
    onNativePassthroughCancel?: () => void;
  } = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    if (err instanceof UnsupportedContentEncodingError) {
      return formatErrorResponse(415, "invalid_request_error", err.message);
    }
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }
  const originalBody = body;
  body = expandPreviousResponseInput(body);
  const previousResponseInputExpanded = body !== originalBody;

  let parsed;
  try {
    parsed = parseRequest(body);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._cursorConversationId = previousResponseConversationId(parsed.previousResponseId);
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  let route;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace
  // (e.g. "opencode-go/deepseek-v4-pro" → "deepseek-v4-pro"). Adapters read parsed.modelId,
  // and the passthrough adapter serializes _rawBody, so rewrite both.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );

  let authCtx: CodexAuthContext;
  let selectedForwardHeaders: Headers;
  try {
    authCtx = options.authContext ?? await resolveCodexAuthContext(req.headers, config);
    selectedForwardHeaders = options.selectedForwardHeaders ?? headersForCodexAuthContext(req.headers, authCtx);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    throw err;
  }
  if (!isCodexAuthContextUsable(authCtx, config)) {
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx);
  logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  if (route.provider.authMode === "oauth") {
    try {
      route.provider = { ...route.provider, apiKey: await getValidAccessToken(route.providerName) };
      // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
      // CCA envelope; the server injects only the bare token, so pull project from the credential.
      if (route.provider.googleMode === "cloud-code-assist" && !route.provider.project) {
        const projectId = getOAuthCredentialProjectId(route.providerName);
        if (projectId) route.provider = { ...route.provider, project: projectId };
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${err.message}. Remove or reconfigure provider '${route.providerName}' in ${getConfigPath()}.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Give it "eyes" —
  // describe each attached image with a gpt vision model via the ChatGPT passthrough and replace it
  // with text BEFORE the main call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, selectedForwardHeaders, authCtx);
  const recordSidecarOutcome = sidecarOutcomeRecorder(config, authCtx);
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan.forwardProvider, selectedForwardHeaders, visionPlan.settings, options.abortSignal, recordSidecarOutcome);
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  const routedCompaction = parsed._compactionRequest === true && !("passthrough" in adapter && adapter.passthrough);
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  if ("passthrough" in adapter && adapter.passthrough) {
    // Local continuation cache for the ChatGPT passthrough. Codex WS turns chain with
    // previous_response_id, ocx converts them to internal HTTP requests, and the ChatGPT Codex
    // REST backend rejects the parameter — the adapter strips it in forward mode, so the ONLY
    // way a chained turn keeps its earlier context is the local replay expansion. Record
    // completed passthrough responses (force bypasses Codex's blanket store:false) so the next
    // turn's expansion hits. Never record a body whose own previous_response_id failed to
    // expand: its input is a delta, and storing it would replay a truncated conversation.
    // Compaction turns are excluded: _rawBody still carries the full pre-compaction history and
    // recording it would let a later expansion rehydrate the chain Codex just replaced.
    const passthroughRecordEligible = parsed._compactionRequest !== true
      && (!parsed.previousResponseId || parsed._previousResponseInputExpanded === true);
    const rememberPassthroughResponse = passthroughRecordEligible
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) =>
        rememberResponseState(parsed._rawBody, response, undefined, { force: true })
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResetRetry(
        () => fetchWithHeaderTimeout(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }, upstream.signal, connectMs),
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } catch (err) {
      upstream.abort();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) recordCodexUpstreamOutcome(config, authCtx.accountId, outcome);
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(config, authCtx, route.provider);
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      const weeklyRaw = upstreamResponse.headers.get("x-codex-secondary-used-percent");
      const fiveHourRaw = upstreamResponse.headers.get("x-codex-primary-used-percent");
      const monthlyRaw = upstreamResponse.headers.get("x-codex-tertiary-used-percent");
      const weeklyResetRaw = upstreamResponse.headers.get("x-codex-secondary-reset-at");
      const fiveHourResetRaw = upstreamResponse.headers.get("x-codex-primary-reset-at");
      const monthlyResetRaw = upstreamResponse.headers.get("x-codex-tertiary-reset-at");
      const retryAfterRaw = upstreamResponse.headers.get("retry-after");
      if (weeklyRaw || fiveHourRaw || monthlyRaw) {
        const { updateAccountQuota } = await import("../codex/auth-api");
        updateAccountQuota(
          authCtx.accountId,
          weeklyRaw,
          fiveHourRaw,
          weeklyResetRaw,
          fiveHourResetRaw,
          monthlyRaw,
          monthlyResetRaw,
        );
      }
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.(status => {
          terminalRecorder(status);
          options.onNativePassthroughTerminal?.(status);
        });
      } else {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
          retryAfter: retryAfterRaw,
          resetAt: [fiveHourResetRaw, weeklyResetRaw, monthlyResetRaw],
        });
      }
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    if (isEventStream && upstreamResponse.body) {
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus) => {
          terminalRecorder?.(status);
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => options.onNativePassthroughCancel?.(),
          rememberPassthroughResponse,
        );
      } else {
        consumeForResponseLogMetadata(inspectBody, logCtx, turnAc.signal, () => unregisterTurn(turnAc), rememberPassthroughResponse);
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // win32 must keep the pure native relay (Bun#32111 JS-sink segfault); elsewhere a JS pull
      // relay is established practice (relayWithAbort, relaySseWithHeartbeat) and lets a
      // mid-stream reset end with a clean response.failed terminal instead of a raw socket error.
      const clientBody = process.platform === "win32"
        ? nativeBody
        : relaySseWithFailedTail(nativeBody, upstream);
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      if (upstreamResponse.ok && rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  if (adapter.runTurn) {
    const runTurnAbort = new AbortController();
    linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue();
    const runTurn = async (): Promise<void> => {
      try {
        await adapter.runTurn?.(
          parsed,
          { headers: selectedForwardHeaders, abortSignal: runTurnAbort.signal },
          queue.push,
        );
      } catch (err) {
        queue.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        queue.close();
      }
    };

    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    if (parsed.stream) {
      void runTurn();
      const sseStream = bridgeToResponsesSSE(
        queue.stream(), parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(routedCompaction ? { compaction: true } : {}),
          ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc);
      return new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }

    await runTurn();
    const events = await queue.collect();
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, selectedForwardHeaders, route.provider, route.modelId, authCtx);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      forwardProvider: wsPlan.forwardProvider,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      recordSidecarOutcome,
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      on429: retryAfter => {
        const rotated = rotateKeyOn429(config, route.providerName, retryAfter, Date.now(), route.provider.apiKey);
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, rotated),
          config.cacheRetention,
        );
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    return wsResponse;
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;

  const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  if (typeof request.usageLog?.inputTokens === "number") {
    logCtx.usageLogInputTokens = request.usageLog.inputTokens;
  }
  let upstreamResponse: Response;
  try {
    upstreamResponse = adapter.fetchResponse
      ? await adapter.fetchResponse(request, { abortSignal: upstream.signal, timeoutMs: connectMs })
      : await fetchWithResetRetry(
          () => fetchWithHeaderTimeout(request.url, {
            method: request.method, headers: request.headers, body: request.body,
          }, upstream.signal, connectMs),
          { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
        );
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the SAME
    // request once per remaining key. OAuth/forward providers and single-key pools return null
    // immediately, so this stays a no-op for them (src/providers/key-failover.ts).
    while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
      const rotated = rotateKeyOn429(config, route.providerName, upstreamResponse.headers.get("retry-after"), Date.now(), route.provider.apiKey);
      if (!rotated) break;
      // Release the failed response's socket before retrying; unread bodies otherwise linger
      // until runtime cleanup (one per rotated key under a rate-limit storm).
      try { void upstreamResponse.body?.cancel(); } catch { /* already consumed/closed */ }
      route.provider = rotated;
      const retryAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, rotated),
        config.cacheRetention,
      );
      const retryRequest = await retryAdapter.buildRequest(parsed, { headers: selectedForwardHeaders });
      try {
        upstreamResponse = retryAdapter.fetchResponse
          ? await retryAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs })
          : await fetchWithHeaderTimeout(retryRequest.url, {
              method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
            }, upstream.signal, connectMs);
      } catch {
        break; // network failure on the retry: fall through to the original error path
      }
    }
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text().catch(() => "unknown error");
      cleanupUpstreamAbort();
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`);
    }
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(routedCompaction ? { compaction: true } : {}),
        // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
        // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
        // giant stale chain Codex just replaced.
        ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse(upstreamResponse);
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Remote compaction v1 (`POST /v1/responses/compact`). Codex uses this whenever the provider
 * "is openai" and Feature::RemoteCompactionV2 is OFF (the default) — under Design B that is the
 * proxy. The response is a unary `{"output":[ResponseItem...]}` that codex installs as the
 * REPLACEMENT history (compact_remote.rs). Passthrough forwards to the real ChatGPT backend;
 * routed models run the same summarizer used for v2 and convert the summary to v1 history items.
 */
export async function handleResponsesCompact(req: Request, config: OcxConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    if (err instanceof UnsupportedContentEncodingError) {
      return formatErrorResponse(415, "invalid_request_error", err.message);
    }
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Invalid compaction request body");
  }
  const raw = body as { model?: unknown; input?: unknown };
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "compaction request requires a model");
  }

  let route;
  try {
    route = routeModel(config, raw.model);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  if (route.provider.adapter === "openai-responses") {
    // Native ChatGPT/OpenAI model: forward the compact request verbatim to the real backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    const headers = new Headers({ "content-type": "application/json" });
    try {
      const authCtx = await resolveCodexAuthContext(req.headers, config);
      const selected = headersForCodexAuthContext(req.headers, authCtx);
      compactProvider = applyCodexAuthContextToProvider(route.provider, authCtx);
      for (const name of FORWARD_HEADERS) {
        const value = selected.get(name);
        if (value) headers.set(name, value);
      }
      const override = (compactProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
      if (override) {
        headers.set("authorization", `Bearer ${override.accessToken}`);
        headers.set("chatgpt-account-id", override.chatgptAccountId);
      }
    } catch {
      // Auth-context failures degrade to raw forwarded headers (pre-existing behavior) rather
      // than failing the compact turn outright — codex-rs treats compact errors as session-fatal.
      for (const name of FORWARD_HEADERS) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    const base = (compactProvider.baseUrl ?? "").replace(/\/$/, "");
    if (compactProvider.apiKey) headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    const upstream = await fetch(`${base}/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...raw, model: route.modelId }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting ocx1 envelope into plain v1 replacement-history items.
  const inputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  const internalBody = {
    ...raw,
    stream: false,
    input: [...inputItems, { type: "compaction_trigger" }],
  };
  const internalHeaders = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) internalHeaders.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify(internalBody),
  });
  const logCtx: RequestLogContext = { model: route.modelId, provider: route.providerName };
  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal });
  if (!response.ok) return response;
  let json: { output?: unknown[] };
  try {
    json = await response.json() as { output?: unknown[] };
  } catch {
    return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
  }
  const compactionItem = (json.output ?? []).find(
    (item): item is { type: string; encrypted_content?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
  );
  const summary = compactionItem?.encrypted_content
    ? decodeCompactionSummary(compactionItem.encrypted_content) ?? ""
    : "";
  const output = buildCompactV1Output(extractCompactUserMessages(inputItems), summary);
  return new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
}

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}

/** Host-only label for retry logs — never leaks path/query/credentials. */
export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}
