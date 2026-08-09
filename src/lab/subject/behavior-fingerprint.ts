import { createHash } from "node:crypto";
import { jcsStringify } from "../digest";
import type { LabRouteContext } from "../live/types";

const CLOSED_BEHAVIOR_KEYS = [
  "wire.adapter",
  "wire.inboundProtocol",
  "wire.upstreamProtocol",
  "wire.surface",
  "route.allowPrivateNetwork",
  "route.labRunApproval",
] as const;

/** Build a closed-key behavior fingerprint from lab-forced route context fields. */
export function buildBehaviorFingerprintV1(routeContext: LabRouteContext): string {
  const values: Record<string, { source: "lab_forced"; value: unknown }> = {
    "wire.adapter": { source: "lab_forced", value: routeContext.effectiveAdapter },
    "wire.inboundProtocol": { source: "lab_forced", value: routeContext.inboundProtocol },
    "wire.upstreamProtocol": { source: "lab_forced", value: routeContext.upstreamProtocol },
    "wire.surface": { source: "lab_forced", value: routeContext.surface },
    "route.allowPrivateNetwork": { source: "lab_forced", value: routeContext.allowPrivateNetwork === true },
    "route.labRunApproval": { source: "lab_forced", value: routeContext.labRunApproval === true },
  };
  for (const key of CLOSED_BEHAVIOR_KEYS) {
    if (!(key in values)) throw new Error(`harness_failure: missing behavior key ${key}`);
  }
  const payload = {
    schemaVersion: 1,
    resolverVersion: 1,
    values,
  };
  return createHash("sha256").update(jcsStringify(payload)).digest("hex");
}
