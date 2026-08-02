import type { TKey } from "../../i18n/shared";
import { IntegrationApiError, type IntegrationRefusalEnvelope } from "./integration-api";

/**
 * Envelopes the server sends that are NOT writer refusals.
 *
 * `integration_mutation_busy` is the common one: it carries no `reason`, so it
 * never becomes a refusal, and without this map the user saw the server's raw
 * English `error` string in every locale.
 */
const CODE_KEYS: Record<string, TKey> = {
  integration_mutation_busy: "integrations.error.busy",
};

/**
 * One place that turns a refusal into the sentence a user can act on.
 *
 * Every surface used to format its own, and each one dropped a different
 * field: the bulk flow lost `snapshotPath`, and nothing anywhere disclosed
 * `residual`. `residual` is the most important of the three — it means
 * compensation itself failed, so the file may be sitting in an intermediate
 * state and the user is the only one who can finish the recovery.
 */
export function refusalOf(error: unknown): IntegrationRefusalEnvelope | null {
  return error instanceof IntegrationApiError ? error.refusal : null;
}

/** Keyed by `reason`, never by `state` (006 §5). */
function reasonKey(reason: string | undefined): TKey {
  if (reason === "conflict") return "integrations.error.conflict";
  if (reason === "unsafe") return "integrations.error.unsafe";
  return "integrations.error.generic";
}

export type Translate = (key: TKey, vars?: Record<string, string>) => string;

export function describeRefusal(t: Translate, error: unknown, fallback?: string): string {
  const refusal = refusalOf(error);
  if (!refusal) {
    const code = error instanceof IntegrationApiError ? String(error.body.code ?? "") : "";
    const known = CODE_KEYS[code];
    if (known) return t(known);
    return error instanceof Error && error.message
      ? error.message
      : fallback ?? t("integrations.error.generic");
  }
  const message = refusal.message || t(reasonKey(refusal.reason));
  if (refusal.snapshotPath) {
    // A dead end the user cannot finish by hand is worse than no rollback at
    // all, so the path rides along whenever the server sent one.
    return t(
      refusal.residual ? "integrations.error.residual" : "integrations.error.recover",
      { message, path: refusal.snapshotPath },
    );
  }
  return refusal.reason === "conflict" || refusal.reason === "unsafe"
    ? `${t(reasonKey(refusal.reason))} ${message}`
    : message;
}
