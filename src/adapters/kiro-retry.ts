import type { AdapterFetchContext, AdapterRequest } from "./base";
import { safeKiroHttpErrorMessage } from "./kiro-errors";
import { normalizeUpstreamHttpErrorResponse } from "./upstream-http-error";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  isConnectionResetError,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "../lib/upstream-retry";

const KIRO_RETRY_ATTEMPTS = 3;
const KIRO_RETRY_BASE_MS = 250;
const KIRO_RETRY_MAX_MS = 2_000;

function retryableKiroStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryableKiroFetchError(err: unknown): boolean {
  return isConnectionResetError(err) || (err instanceof Error && err.name === "TimeoutError");
}

async function normalizeFinalKiroHttpError(res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeKiroHttpErrorMessage(res.status, res.headers, payloadText),
  });
}

export async function fetchKiroWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < KIRO_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await fetchWithAttemptDeadline(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, timeoutMs, ctx.abortSignal, ctx.stream);
      if (!retryableKiroStatus(res.status) || attempt === KIRO_RETRY_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalKiroHttpError(res, ctx.abortSignal);
      }
      cancelResponseBodyBestEffort(res);
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: KIRO_RETRY_BASE_MS,
        maxDelayMs: KIRO_RETRY_MAX_MS,
        headers: res.headers,
      }), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      if (!retryableKiroFetchError(err) || attempt === KIRO_RETRY_ATTEMPTS - 1) throw err;
      lastError = err;
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: KIRO_RETRY_BASE_MS,
        maxDelayMs: KIRO_RETRY_MAX_MS,
      }), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error("Kiro fetch failed");
}
