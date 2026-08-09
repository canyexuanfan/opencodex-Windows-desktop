import type { RouteDependencyV1 } from "../events/types";

export interface LabDestinationV1 {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly sniHost: string;
  readonly addresses: ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>;
  readonly privateNetwork: boolean;
  readonly fingerprint: string;
}

export interface LabRouteContext {
  providerId: string;
  clientModelId: string;
  upstreamModelId: string;
  effectiveAdapter: string;
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
  baseUrl: string;
  allowPrivateNetwork?: boolean;
  labRunApproval?: boolean;
  requiredClaims?: string[];
  dependencies?: RouteDependencyV1[];
}

export interface LiveRunConfig {
  totalTimeoutMs: number;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxRequests: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxMemoryBytes: number;
  maxChildProcesses: number;
  maxArtifacts: number;
  perArtifactBytes: number;
  aggregateArtifactBytes: number;
}

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export type TransportErrorCode =
  | "auth_blocked"
  | "quota_blocked"
  | "network_blocked"
  | "region_blocked"
  | "provider_transient"
  | "redirect_blocked"
  | "destination_mismatch"
  | "host_sni_mismatch"
  | "connect_timeout"
  | "first_byte_timeout"
  | "inactivity_timeout"
  | "total_timeout"
  | "request_limit"
  | "harness_failure";

export interface TransportRequest {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface LabTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

export const LAB_CREDENTIAL_LEASE = Symbol("LabCredentialLeaseV1");

export interface LabCredentialLeaseV1 {
  readonly [LAB_CREDENTIAL_LEASE]: true;
  readonly destinationFingerprint: string;
  readonly transportId: string;
  readonly remainingRequests: number;
  consume(): void;
}

export interface LiveScenarioRunResult {
  scenarioId: string;
  suite: string;
  startedAt: number;
  completedAt: number;
  passed: boolean;
  classification: string;
  secondaryCode?: string;
  assertionResults: import("../conformance/types").AssertionResult[];
  diagnostics: string[];
  routeSubject: import("../events/types").RouteSubjectV1;
  transportError?: TransportErrorCode;
}
