/**
 * Which models may serve AS the vision sidecar (the describer), as opposed to the
 * models the sidecar describes FOR.
 *
 * Two rules make this non-obvious, and both are load-bearing:
 *
 * 1. `provider.noVisionModels` marks models the proxy describes images for, and
 *    `applyProviderConfigHints` deliberately ADDS "image" to their advertised
 *    input modalities so the Codex app does not block the attachment client-side.
 *    A blind model therefore advertises image input. Membership in that list is a
 *    hard disqualifier here, checked BEFORE the modality list it rewrote.
 * 2. Catalog rows frequently omit `inputModalities` entirely (the live
 *    `/api/models` response carries none for either openai or anthropic rows).
 *    Unknown is not zero: when no source can speak, the model stays eligible
 *    rather than silently vanishing from the picker.
 */
import { modelInList, type OcxConfig } from "../types";
import { getModelMetadataCaseInsensitive, resolveMetadataProvider } from "../generated/model-metadata";
import { nativeInputModalities } from "../codex/catalog/metadata";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";

/** The two wire protocols `planVisionSidecar` can actually dispatch to. */
export type VisionSidecarBackend = "openai" | "anthropic";

/** Guaranteed entry per backend: cheap, image-capable, and present in every deployment. */
export const BASELINE_VISION_MODELS: Record<VisionSidecarBackend, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
};

export interface VisionCandidateModel {
  provider: string;
  id: string;
  inputModalities?: string[];
  native?: boolean;
}

export interface VisionModelOption {
  value: string;
  label: string;
  backend: VisionSidecarBackend;
  /** True when the row is a guaranteed baseline rather than a catalog discovery. */
  baseline?: boolean;
}

function advertisesImageInput(modalities: readonly string[] | undefined): boolean | undefined {
  if (!modalities || modalities.length === 0) return undefined;
  return modalities.includes("image");
}

/** Vendor-table modalities for a routed row, or undefined when the table has no opinion. */
function metadataImageInput(provider: string, modelId: string): boolean | undefined {
  const resolved = resolveMetadataProvider(provider) ?? provider;
  const meta = getModelMetadataCaseInsensitive(resolved, modelId);
  return advertisesImageInput(meta?.input);
}

/**
 * Is this model listed as one the sidecar describes FOR? Such a model cannot be
 * the describer, and its advertised modalities are untrustworthy.
 */
export function isVisionSidecarConsumer(config: Pick<OcxConfig, "providers">, providerName: string, modelId: string): boolean {
  const provider = config.providers?.[providerName];
  return provider ? modelInList(provider.noVisionModels, modelId) : false;
}

/**
 * Can this model accept an image on the wire? Sources are consulted in descending
 * trustworthiness; the first that speaks wins. `undefined` means nothing knows,
 * which callers treat as eligible.
 */
export function modelAcceptsImageInput(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean | undefined {
  if (isVisionSidecarConsumer(config, candidate.provider, candidate.id)) return false;
  if (candidate.native || SUPPORTED_NATIVE_OPENAI_SLUGS.has(candidate.id)) {
    return advertisesImageInput(nativeInputModalities(candidate.id)) ?? true;
  }
  const fromRow = advertisesImageInput(candidate.inputModalities);
  if (fromRow !== undefined) return fromRow;
  return metadataImageInput(candidate.provider, candidate.id);
}

/** Eligible = not a sidecar consumer, and not positively known to be text-only. */
export function isVisionEligibleModel(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): boolean {
  return modelAcceptsImageInput(config, candidate) !== false;
}

/** Which backend would describe through this row, or undefined when neither can. */
export function visionBackendForCandidate(
  config: Pick<OcxConfig, "providers">,
  candidate: VisionCandidateModel,
): VisionSidecarBackend | undefined {
  if (candidate.native || candidate.provider === "openai") return "openai";
  const adapter = config.providers?.[candidate.provider]?.adapter;
  if (adapter === "anthropic") return "anthropic";
  return undefined;
}

/**
 * The picker's option list: every eligible row reachable by one of the two
 * executors, plus each enabled side's baseline, de-duplicated and stably ordered
 * (openai side first, baselines first within a side).
 *
 * This is the SUGGESTION list (narrow): it emits only rows an executor can reach
 * and some source has heard of. It is deliberately NOT the same set as the write
 * gate. `modelAcceptsImageInput` answers "can we prove this model cannot see?"
 * and is the only input to rejection. Absence from this list must never imply
 * rejection — an unknown id stays eligible via the undefined → eligible fallback.
 *
 * De-duplication is by BARE model id, first eligible row wins. Two providers of
 * the same adapter family can expose the same id; they resolve to the same
 * backend, and only `value` reaches the client, so first-wins costs nothing.
 */
export function visionEligibleModelOptions(
  config: Pick<OcxConfig, "providers">,
  candidates: readonly VisionCandidateModel[],
  enabledBackends: readonly VisionSidecarBackend[],
): VisionModelOption[] {
  const enabled = new Set(enabledBackends);
  const byValue = new Map<string, VisionModelOption>();

  for (const backend of ["openai", "anthropic"] as const) {
    if (!enabled.has(backend)) continue;
    const id = BASELINE_VISION_MODELS[backend];
    byValue.set(id, { value: id, label: id, backend, baseline: true });
  }
  for (const candidate of candidates) {
    const backend = visionBackendForCandidate(config, candidate);
    if (!backend || !enabled.has(backend)) continue;
    if (!isVisionEligibleModel(config, candidate)) continue;
    if (byValue.has(candidate.id)) continue;
    byValue.set(candidate.id, { value: candidate.id, label: candidate.id, backend });
  }

  const order = (option: VisionModelOption) =>
    (option.backend === "openai" ? 0 : 2) + (option.baseline ? 0 : 1);
  return [...byValue.values()].sort((a, b) => order(a) - order(b) || a.value.localeCompare(b.value));
}
