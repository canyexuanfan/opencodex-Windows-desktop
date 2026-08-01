import { readBoundedResponseBody } from "../lib/bounded-body";

export type CodexResetEligibleExhaustionCode =
  | "usage_limit_exceeded"
  | "insufficient_quota";

export type CodexPreStreamRejectionKind =
  | "reset-eligible-exhaustion"
  | "generic-rate-limit"
  | "unverified-billing-or-quota"
  | "transient-server-error"
  | "authentication-error"
  | "permission-error"
  | "other";

export interface CodexPreStreamRejection {
  kind: CodexPreStreamRejectionKind;
  status: number;
  alternateRetryEligible: boolean;
  resetCreditEligible: boolean;
  semanticCode?: CodexResetEligibleExhaustionCode;
}

const RESET_ELIGIBLE_CODES = new Set<CodexResetEligibleExhaustionCode>([
  "usage_limit_exceeded",
  "insufficient_quota",
]);

const TRANSIENT_SERVER_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522]);

function rejection(
  status: number,
  kind: CodexPreStreamRejectionKind,
  options: {
    alternateRetryEligible?: boolean;
    semanticCode?: CodexResetEligibleExhaustionCode;
  } = {},
): CodexPreStreamRejection {
  return {
    kind,
    status,
    alternateRetryEligible: options.alternateRetryEligible === true,
    resetCreditEligible: options.semanticCode !== undefined,
    ...(options.semanticCode ? { semanticCode: options.semanticCode } : {}),
  };
}

function structuredResetEligibleCode(payload: unknown): CodexResetEligibleExhaustionCode | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const containers: Record<string, unknown>[] = [root];
  if (root.error && typeof root.error === "object" && !Array.isArray(root.error)) {
    containers.push(root.error as Record<string, unknown>);
  }
  for (const container of containers) {
    for (const field of ["code", "type"] as const) {
      const value = container[field];
      if (typeof value !== "string") continue;
      const normalized = value.trim().toLowerCase();
      if (RESET_ELIGIBLE_CODES.has(normalized as CodexResetEligibleExhaustionCode)) {
        return normalized as CodexResetEligibleExhaustionCode;
      }
    }
  }
  return undefined;
}

async function resetEligibleCodeFromResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<CodexResetEligibleExhaustionCode | undefined> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return undefined;
    return structuredResetEligibleCode(JSON.parse(body.text) as unknown);
  } catch {
    // Classification must fail closed. A malformed, oversized, consumed, or
    // cancelled body cannot authorize an irreversible reset-credit operation.
    return undefined;
  }
}

/**
 * Classify an upstream Codex rejection before any response event is exposed.
 *
 * Only an exact structured exhaustion code on HTTP 429/402 is reset-eligible.
 * Status alone and message text are intentionally insufficient. The broad
 * alternate-account retry remains eligible for 429/402 to preserve #584.
 */
export async function classifyCodexPreStreamRejection(
  response: Response,
  options: { signal?: AbortSignal } = {},
): Promise<CodexPreStreamRejection> {
  const status = response.status;
  if (status === 401) return rejection(status, "authentication-error");
  if (status === 403) return rejection(status, "permission-error");
  if (TRANSIENT_SERVER_STATUSES.has(status)) return rejection(status, "transient-server-error");
  if (status !== 429 && status !== 402) return rejection(status, "other");

  const semanticCode = await resetEligibleCodeFromResponse(response, options.signal);
  if (semanticCode) {
    return rejection(status, "reset-eligible-exhaustion", {
      alternateRetryEligible: true,
      semanticCode,
    });
  }
  return rejection(
    status,
    status === 429 ? "generic-rate-limit" : "unverified-billing-or-quota",
    { alternateRetryEligible: true },
  );
}
