import { PROVIDER_REGISTRY } from "./registry";
import type { ProviderRegistryEntry } from "./registry";
import { OPENAI_API_PROVIDER_ID } from "./openai-tiers";
import type { OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import type { RequestLogContext } from "../server/request-log";

function getApiRegistry(): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(e => e.id === OPENAI_API_PROVIDER_ID);
}

export interface VirtualModelResolution {
  wireModelId: string;
  reasoningMode: "pro";
  selectedModelId: string;
}

/**
 * Resolve a virtual model id to its wire model and reasoning mode.
 * Returns undefined when the model is not a virtual Pro alias on the API provider.
 */
export function resolveOpenAiVirtualModel(
  providerName: string,
  selectedModelId: string,
): VirtualModelResolution | undefined {
  if (providerName !== OPENAI_API_PROVIDER_ID) return undefined;
  const entry = getApiRegistry();
  if (!entry?.virtualModels) return undefined;
  const mapping = entry.virtualModels[selectedModelId];
  if (!mapping) return undefined;
  if (!mapping.wireModelId || mapping.wireModelId === selectedModelId) return undefined;
  return { wireModelId: mapping.wireModelId, reasoningMode: mapping.reasoningMode, selectedModelId };
}

/**
 * Apply virtual model rewriting to a Responses request.
 * Rewrites model id to the base wire model and merges reasoning.mode="pro".
 * Preserves effort and other reasoning fields.
 */
export function applyOpenAiVirtualModel(
  parsed: OcxParsedRequest,
  route: RouteResult,
  logCtx: RequestLogContext,
): void {
  const resolution = resolveOpenAiVirtualModel(route.providerName, route.modelId);
  if (!resolution) return;

  // Record identities: model = selected virtual id, requestedModel already set by caller
  logCtx.model = resolution.selectedModelId;
  logCtx.resolvedModel = resolution.wireModelId;

  // Rewrite model id to base
  route.modelId = resolution.wireModelId;
  parsed.modelId = resolution.wireModelId;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = resolution.wireModelId;
  }

  // Merge reasoning.mode = "pro", preserving existing effort and other fields
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    const raw = parsed._rawBody as Record<string, unknown>;
    const existing = (raw.reasoning ?? {}) as Record<string, unknown>;
    raw.reasoning = { ...existing, mode: resolution.reasoningMode };
  }
}

/**
 * Resolve a virtual model for compact requests.
 * Returns the base wire model id, or the original if not virtual.
 * Compact has no reasoning field — mode is not injected.
 */
export function resolveOpenAiCompactModel(
  providerName: string,
  selectedModelId: string,
): { wireModelId: string; isVirtual: boolean } {
  const resolution = resolveOpenAiVirtualModel(providerName, selectedModelId);
  if (!resolution) return { wireModelId: selectedModelId, isVirtual: false };
  return { wireModelId: resolution.wireModelId, isVirtual: true };
}
