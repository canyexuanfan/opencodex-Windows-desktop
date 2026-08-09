import { providerRedirectError } from "../../lib/provider-outbound";
import { assertLeaseScope } from "./credential-lease";
import type {
  LabCredentialLeaseV1,
  LabDestinationV1,
  LabTransport,
  TransportErrorCode,
  TransportRequest,
  TransportResponse,
} from "./types";

export interface MockTransportEntry {
  matchPath?: string | RegExp;
  status: number;
  headers?: Record<string, string>;
  body: string;
  error?: TransportErrorCode;
}

export interface MockTransportOptions {
  entries?: MockTransportEntry[];
  onRequest?: (req: TransportRequest) => void;
}

/** Injectable mock transport for tests — returns fixture upstream responses. */
export function createMockTransport(opts: MockTransportOptions = {}): LabTransport {
  let callIndex = 0;
  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      opts.onRequest?.(req);
      const entry = opts.entries?.[callIndex] ?? opts.entries?.[opts.entries.length - 1];
      callIndex += 1;
      if (!entry) {
        throw transportError("harness_failure", "no mock transport entry");
      }
      if (entry.error) throw transportError(entry.error, entry.error);
      if (entry.matchPath) {
        const matches = typeof entry.matchPath === "string"
          ? req.path.includes(entry.matchPath)
          : entry.matchPath.test(req.path);
        if (!matches) throw transportError("harness_failure", "mock path mismatch");
      }
      if (entry.status >= 300 && entry.status < 400) {
        throw transportError("redirect_blocked", "redirect response");
      }
      return {
        status: entry.status,
        headers: { ...(entry.headers ?? {}), "content-type": entry.headers?.["content-type"] ?? "application/json" },
        body: entry.body,
      };
    },
  };
}

export interface PinnedTransportOptions {
  destination: LabDestinationV1;
  lease: LabCredentialLeaseV1;
  fetch?: typeof globalThis.fetch;
  transportId?: string;
}

/** Production path: provider-outbound with pinned destination; lease consumed per request. */
export function createPinnedTransport(opts: PinnedTransportOptions): LabTransport {
  const transportId = opts.transportId ?? "default";
  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      assertLeaseScope(opts.lease, opts.destination, transportId);
      opts.lease.consume();
      const url = `${opts.destination.scheme}://${opts.destination.host}:${opts.destination.port}${opts.destination.basePath}${req.path}`;
      const fetchFn = opts.fetch ?? globalThis.fetch;
      const response = await fetchFn(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
      });
      const redirectError = await providerRedirectError(response, url);
      if (redirectError) throw transportError("redirect_blocked", redirectError);
      if (response.status === 401 || response.status === 403) {
        throw transportError("auth_blocked", `HTTP ${response.status}`);
      }
      if (response.status === 429) {
        throw transportError("quota_blocked", `HTTP ${response.status}`);
      }
      if (response.status >= 500) {
        throw transportError("provider_transient", `HTTP ${response.status}`);
      }
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body };
    },
  };
}

export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function transportError(code: TransportErrorCode, message: string): TransportError {
  return new TransportError(code, message);
}

export function classifyTransportError(error: unknown): { classification: string; secondaryCode: string } {
  if (error instanceof TransportError) {
    switch (error.code) {
      case "auth_blocked":
        return { classification: "authentication_blocked", secondaryCode: "auth_blocked" };
      case "quota_blocked":
        return { classification: "quota_blocked", secondaryCode: "quota_blocked" };
      case "network_blocked":
        return { classification: "network_failure", secondaryCode: "network_blocked" };
      case "region_blocked":
        return { classification: "region_blocked", secondaryCode: "region_blocked" };
      case "provider_transient":
        return { classification: "provider_transient", secondaryCode: "provider_transient" };
      case "connect_timeout":
      case "first_byte_timeout":
      case "inactivity_timeout":
      case "total_timeout":
        return { classification: "timeout", secondaryCode: error.code };
      case "request_limit":
        return { classification: "budget_exhausted", secondaryCode: "scenario_resource_limit" };
      case "redirect_blocked":
      case "destination_mismatch":
      case "host_sni_mismatch":
      case "harness_failure":
        return { classification: "harness_failure", secondaryCode: error.code };
      default: {
        const _never: never = error.code;
        return { classification: "harness_failure", secondaryCode: String(_never) };
      }
    }
  }
  return { classification: "harness_failure", secondaryCode: "execution_error" };
}
