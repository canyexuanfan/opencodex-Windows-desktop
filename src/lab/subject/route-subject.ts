import { localFingerprint } from "../digest";
import type { RouteSubjectV1 } from "../events/types";
import type { LabDestinationV1, LabRouteContext } from "../live/types";
import { buildBehaviorFingerprintV1 } from "./behavior-fingerprint";
import { readInstallationSalt } from "./installation-salt";

const COMPAT_VERSION = "live-v1";

function destinationSnapshotForFingerprint(destination: LabDestinationV1): Record<string, unknown> {
  return {
    scheme: destination.scheme,
    host: destination.host,
    port: destination.port,
    basePath: destination.basePath,
  };
}

/** Build a frozen RouteSubjectV1 from route context and immutable destination snapshot. */
export function buildRouteSubjectV1(
  routeContext: LabRouteContext,
  destination: LabDestinationV1,
  configDir?: string,
): RouteSubjectV1 {
  const salt = readInstallationSalt(configDir);
  const endpointFingerprint = localFingerprint(
    "endpoint",
    destinationSnapshotForFingerprint(destination),
    salt,
  );
  const providerInstanceFingerprint = localFingerprint(
    "providerInstance",
    {
      providerId: routeContext.providerId,
      clientModelId: routeContext.clientModelId,
      upstreamModelId: routeContext.upstreamModelId,
      effectiveAdapter: routeContext.effectiveAdapter,
      inboundProtocol: routeContext.inboundProtocol,
      upstreamProtocol: routeContext.upstreamProtocol,
      surface: routeContext.surface,
    },
    salt,
  );
  return Object.freeze({
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: routeContext.providerId,
    providerInstanceFingerprint,
    clientModelId: routeContext.clientModelId,
    upstreamModelId: routeContext.upstreamModelId,
    effectiveAdapter: routeContext.effectiveAdapter,
    inboundProtocol: routeContext.inboundProtocol,
    upstreamProtocol: routeContext.upstreamProtocol,
    surface: routeContext.surface,
    opencodexCompatibilityVersion: COMPAT_VERSION,
    behaviorFingerprint: buildBehaviorFingerprintV1(routeContext),
    endpointFingerprint,
    dependencies: routeContext.dependencies ?? [],
  });
}

/** Deep-freeze a route subject before live execution. */
export function freezeRouteSubject(subject: RouteSubjectV1): RouteSubjectV1 {
  return Object.freeze({
    ...subject,
    dependencies: [...subject.dependencies],
  });
}
