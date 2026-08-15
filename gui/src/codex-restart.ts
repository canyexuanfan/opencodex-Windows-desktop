import type {
  CodexRestartCode,
  CodexRestartResponse,
} from "../../src/lib/codex-restart-contract";
import { isCodexRestartResponse } from "../../src/lib/codex-restart-contract";

export interface CodexRestartOutcome {
  ok: boolean;
  result?: CodexRestartResponse;
  /** Localized by the caller through the format* options. */
  message?: string;
}

export interface CodexRestartOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  formatFailure?: (status: number) => string;
  formatUnreachable?: () => string;
  formatMalformed?: () => string;
}

// Enumeration can shell out to ps, procfs, or PowerShell CIM, and the request also
// rewrites the catalog first, so this is slower than an ordinary management call.
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * POST /api/system/codex-restart.
 *
 * Unlike `requestProxyStop`, a dropped connection here is a real failure: this
 * route does not kill the process serving it, so silence means something broke
 * rather than "the shutdown you asked for started".
 */
export async function requestCodexRestart(
  apiBase: string,
  options: CodexRestartOptions = {},
): Promise<CodexRestartOutcome> {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    formatFailure = status => `Failed to restart Codex (HTTP ${status}).`,
    formatUnreachable = () => "Could not reach the proxy.",
    formatMalformed = () => "The proxy returned an unexpected response.",
  } = options;

  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/api/system/codex-restart`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, message: formatUnreachable() };
  }

  if (!response.ok) return { ok: false, message: formatFailure(response.status) };

  const payload = await response.json().catch(() => null) as unknown;
  // A parseable 2xx body of the wrong shape must not reach the caller: the handler
  // reads .stopped.length and .surviving.length and would throw inside an event
  // handler, where the failure surfaces as a dead button rather than a message.
  if (!isCodexRestartResponse(payload)) return { ok: false, message: formatMalformed() };
  return { ok: true, result: payload };
}

export type { CodexRestartCode, CodexRestartResponse };

