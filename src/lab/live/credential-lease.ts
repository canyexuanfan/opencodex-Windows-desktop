import { LAB_CREDENTIAL_LEASE, type LabCredentialLeaseV1, type LabDestinationV1 } from "./types";

export class LabCredentialError extends Error {
  override readonly name = "LabCredentialError";
  constructor(
    message: string,
    readonly code: "auth_blocked" | "harness_failure",
  ) {
    super(message);
  }
}

export interface CreateLeaseOptions {
  destination: LabDestinationV1;
  transportId?: string;
  budget?: number;
  authOutcome?: "ok" | "blocked";
}

/** Create an opaque credential lease bound to destination + transport + budget. */
export function createCredentialLease(opts: CreateLeaseOptions): LabCredentialLeaseV1 {
  if (opts.authOutcome === "blocked") {
    throw new LabCredentialError("credential rejected for destination", "auth_blocked");
  }
  const budget = opts.budget ?? 1;
  let remaining = budget;
  const lease: LabCredentialLeaseV1 = {
    [LAB_CREDENTIAL_LEASE]: true,
    destinationFingerprint: opts.destination.fingerprint,
    transportId: opts.transportId ?? "default",
    get remainingRequests() {
      return remaining;
    },
    consume() {
      if (remaining <= 0) {
        throw new LabCredentialError("credential lease exhausted", "auth_blocked");
      }
      remaining -= 1;
    },
  };
  return Object.freeze(lease);
}

export function isCredentialLease(value: unknown): value is LabCredentialLeaseV1 {
  return typeof value === "object" && value !== null && (value as LabCredentialLeaseV1)[LAB_CREDENTIAL_LEASE] === true;
}

export function assertLeaseScope(
  lease: LabCredentialLeaseV1,
  destination: LabDestinationV1,
  transportId = "default",
): void {
  if (lease.destinationFingerprint !== destination.fingerprint) {
    throw new LabCredentialError("lease destination mismatch", "auth_blocked");
  }
  if (lease.transportId !== transportId) {
    throw new LabCredentialError("lease transport mismatch", "auth_blocked");
  }
}
