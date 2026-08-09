import type {
  LabRouteExecutor,
  LabSandboxBoundary,
  TrustedLabRouteExecutor,
} from "../lab/live/types";
import { REQUIRED_LAB_SANDBOX_BOUNDARIES } from "../lab/live/types";

const TRUSTED_EXECUTORS = new WeakSet<object>();

function exactRequiredBoundaries(boundaries: readonly LabSandboxBoundary[]): boolean {
  const actual = new Set(boundaries);
  return actual.size === REQUIRED_LAB_SANDBOX_BOUNDARIES.length
    && REQUIRED_LAB_SANDBOX_BOUNDARIES.every((boundary) => actual.has(boundary));
}

/**
 * Trusted non-Lab construction boundary for the exact-route executor.
 *
 * Callers may create this capability only after wiring enforcement for every required
 * sandbox boundary. Missing or partial enforcement is rejected rather than silently
 * producing live evidence with weaker guarantees.
 */
export function createTrustedLabRouteExecutor(
  execute: LabRouteExecutor,
  enforcedBoundaries: readonly LabSandboxBoundary[],
): TrustedLabRouteExecutor {
  if (!exactRequiredBoundaries(enforcedBoundaries)) {
    throw new Error("harness_failure: trusted Lab route executor lacks required sandbox enforcement");
  }
  const capability: TrustedLabRouteExecutor = Object.freeze({
    execute,
    enforcedBoundaries: Object.freeze([...enforcedBoundaries]),
  });
  TRUSTED_EXECUTORS.add(capability);
  return capability;
}

export function isTrustedLabRouteExecutor(value: unknown): value is TrustedLabRouteExecutor {
  return typeof value === "object" && value !== null && TRUSTED_EXECUTORS.has(value as object)
    && exactRequiredBoundaries((value as TrustedLabRouteExecutor).enforcedBoundaries);
}
