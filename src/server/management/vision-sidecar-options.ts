/**
 * The one place that decides which models the management API offers as vision
 * describers, and which it refuses to persist.
 *
 * Two routes write a vision sidecar model — `PUT /api/sidecar-settings` and the
 * `visionSidecar` override in `PUT /api/claude-code`. They share this module so
 * the policy cannot drift: a gate on one route and a stale copy on the other is
 * the same as no gate at all.
 */
import type { OcxConfig } from "../../types";
import { findAnthropicVisionProvider } from "../../vision";
import {
  modelAcceptsImageInput,
  visionEligibleModelOptions,
  type VisionCandidateModel,
  type VisionModelOption,
  type VisionSidecarBackend,
} from "../../vision/eligibility";
import { listOpenAiForwardSidecarCandidates } from "../../providers/openai-sidecar";
import { listManagementModelRows } from "./model-rows";

/** Backends whose executor could actually run: openai forward, anthropic OAuth. */
export function enabledVisionBackends(config: OcxConfig): VisionSidecarBackend[] {
  const backends: VisionSidecarBackend[] = [];
  // The OpenAI describer needs a CANONICAL ChatGPT forward provider, not merely a
  // provider keyed "openai" — same predicate the runtime sidecar resolver uses.
  if (listOpenAiForwardSidecarCandidates(config).length > 0) backends.push("openai");
  if (findAnthropicVisionProvider(config)) backends.push("anthropic");
  // Neither side resolvable (fresh install, no login): fall back to both so the
  // picker is populated rather than empty, matching the permissive-unknown rule.
  return backends.length > 0 ? backends : ["openai", "anthropic"];
}

/** Visible catalog rows in the shape the eligibility predicate consumes. */
export async function visionCandidateRows(config: OcxConfig): Promise<VisionCandidateModel[]> {
  let rows: Awaited<ReturnType<typeof listManagementModelRows>> = [];
  // A catalog outage must not 500 the settings route nor reject a write; with []
  // the option list degrades to the baselines, which is the intended floor.
  try { rows = await listManagementModelRows(config); } catch { rows = []; }
  return rows.filter(row => row.disabled !== true).map(row => ({
    provider: row.provider,
    id: row.id,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.native ? { native: true } : {}),
  }));
}

export function visionModelOptionsFrom(
  config: OcxConfig,
  candidates: readonly VisionCandidateModel[],
): VisionModelOption[] {
  return visionEligibleModelOptions(config, candidates, enabledVisionBackends(config));
}

/** Convenience for read paths that have no candidate list in hand yet. */
export async function visionModelOptionsFor(config: OcxConfig): Promise<VisionModelOption[]> {
  return visionModelOptionsFrom(config, await visionCandidateRows(config));
}

/**
 * Can we PROVE the requested describer is blind?
 *
 * Only a positive `false` rejects. An id no source knows stays allowed, because
 * the runtime never required catalog membership and an operator may be ahead of
 * our tables.
 *
 * When no catalog row matches, the caller's `backend` is only a HINT, never the
 * authority. Trusting it let a client launder a known-blind OpenAI model past the
 * gate by claiming `backend: "anthropic"`, since the id is absent from the
 * Anthropic table and absence reads as "unknown". Both families are therefore
 * consulted and any positive text-only verdict wins. That is safe precisely
 * because the two vendor tables share no bare model id, so they can never
 * disagree about one.
 */
export function visionDescriberIsProvablyBlind(
  config: OcxConfig,
  requested: string,
  candidates: readonly VisionCandidateModel[],
  backendHint: VisionSidecarBackend | undefined,
): boolean {
  const row = candidates.find(candidate => candidate.id === requested);
  if (row) return modelAcceptsImageInput(config, row) === false;

  const hinted: VisionSidecarBackend = backendHint === "anthropic" ? "anthropic" : "openai";
  const probed: VisionSidecarBackend[] = hinted === "anthropic"
    ? ["anthropic", "openai"]
    : ["openai", "anthropic"];
  return probed.some(provider => modelAcceptsImageInput(config, { provider, id: requested }) === false);
}

/** The 400 body both routes return, so the two errors cannot diverge either. */
export function visionDescriberRejection(
  field: "vision.model" | "visionSidecar.model",
  requested: string,
  config: OcxConfig,
  candidates: readonly VisionCandidateModel[],
): { error: string; allowed: string[] } {
  return {
    error: `${field} "${requested}" cannot describe images: it has no image input support, or it is a model the vision sidecar describes FOR.`,
    allowed: visionModelOptionsFrom(config, candidates).map(option => option.value),
  };
}
