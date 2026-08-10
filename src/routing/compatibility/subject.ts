import type { OcxConfig, OcxProviderConfig } from "../../types";
import { subjectIdForSubject } from "../../lab/digest";
import { buildRouteSubjectV1 } from "../../lab/subject/route-subject";
import type { LabDestinationV1, LabRouteContext } from "../../lab/live/types";
import { endpointFingerprintFromBaseUrl, parseEndpointFingerprintParts } from "./endpoint";
import {
  providerInstanceKey,
  resolveProductionBehaviorValues,
  surfaceForProtocols,
  upstreamProtocolForAdapter,
} from "./behavior";
import { readOpenCodexCompatibilityVersion } from "./version";

const POLICY_INBOUND_PROTOCOL = "openai-responses";

export interface ResolvedPolicyRouteSubject {
  subjectId: string;
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
}

function destinationSnapshotFromBaseUrl(baseUrl: string, fingerprint: string): LabDestinationV1 {
  const parts = parseEndpointFingerprintParts(baseUrl);
  if (!parts) throw new Error("invalid provider baseUrl for route subject");
  return Object.freeze({
    scheme: parts.scheme,
    host: parts.host,
    port: parts.port,
    basePath: parts.basePath,
    sniHost: parts.host,
    addresses: Object.freeze([]),
    privateNetwork: false,
    fingerprint,
  });
}

/**
 * Build exact RouteSubjectV1 identity for a policy candidate without network I/O.
 */
export function resolvePolicyRouteSubject(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  configDir?: string,
): ResolvedPolicyRouteSubject | null {
  const baseUrl = typeof routed.baseUrl === "string" ? routed.baseUrl.trim() : "";
  if (!baseUrl) return null;
  const endpointFp = endpointFingerprintFromBaseUrl(baseUrl, configDir);
  if (!endpointFp) return null;

  const destination = destinationSnapshotFromBaseUrl(baseUrl, endpointFp);
  const adapter = routed.adapter ?? "openai-responses";
  const upstreamProtocol = upstreamProtocolForAdapter(adapter);
  const surface = surfaceForProtocols(POLICY_INBOUND_PROTOCOL, upstreamProtocol);
  const behaviorValues = resolveProductionBehaviorValues(config, providerName, modelId, routed);
  if (!behaviorValues) return null;

  const routeContext: LabRouteContext = {
    providerId: providerName,
    providerInstanceKey: providerInstanceKey(providerName, routed),
    clientModelId: modelId,
    upstreamModelId: modelId,
    effectiveAdapter: adapter,
    inboundProtocol: POLICY_INBOUND_PROTOCOL,
    upstreamProtocol,
    surface,
    baseUrl,
    opencodexCompatibilityVersion: readOpenCodexCompatibilityVersion(),
    behaviorValues,
    dependencies: [],
  };

  try {
    const subject = buildRouteSubjectV1(routeContext, destination, configDir);
    return {
      subjectId: subjectIdForSubject(subject),
      routeContext,
      destination,
    };
  } catch {
    return null;
  }
}
