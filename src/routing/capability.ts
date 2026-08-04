/**
 * Candidate capability evidence for policy routing (RI-05).
 *
 * Evidence comes from canonical local sources only - provider config maps,
 * the provider registry, the cached Codex catalog file, and the native-model
 * metadata helpers. No live network fetch happens at routing time.
 *
 * "Unknown is not zero": any dimension without canonical evidence stays
 * `undefined` (unknown) and the profile's `unknownEvidence` policy decides
 * how that affects eligibility.
 */

import type { OcxConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { PROVIDER_REGISTRY } from "../providers/registry";
import {
  nativeInputModalities,
  nativeOpenAiContextWindow,
  nativeParallelToolCalls,
  nativeReasoningEfforts,
} from "../codex/catalog/metadata";
import { readCatalog, readCodexCatalogPath } from "../codex/catalog/parsing";
import type { RouteCapabilityEvidence } from "./trace";

function cachedCatalogModels(): Array<{ provider: string; id: string; contextWindow?: number; inputModalities?: string[]; reasoningEfforts?: string[]; capabilities?: string[] }> {
  try {
    const catalog = readCatalog(readCodexCatalogPath());
    const models = catalog?.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter((model): model is Record<string, unknown> & { id: string; provider: string } =>
        typeof model === "object" && model !== null && typeof model.id === "string" && typeof model.provider === "string")
      .map(model => ({
        provider: model.provider,
        id: model.id,
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(Array.isArray(model.inputModalities)
          ? { inputModalities: model.inputModalities.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(model.reasoningEfforts)
          ? { reasoningEfforts: model.reasoningEfforts.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(model.capabilities)
          ? { capabilities: model.capabilities.filter((value): value is string => typeof value === "string") }
          : {}),
      }));
  } catch {
    return [];
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized === "127.0.0.1"
    || normalized === "::1" || normalized === "[::1]"
    || normalized.endsWith(".localhost");
}

function isPrivateHostname(hostname: string): boolean {
  return hostname.startsWith("10.") || hostname.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

function localRemoteEvidence(baseUrl: string | undefined): Pick<RouteCapabilityEvidence, "localOnly" | "remoteAllowed"> {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return {};
  try {
    const hostname = new URL(baseUrl).hostname;
    if (!hostname) return {};
    if (isLocalHostname(hostname) || isPrivateHostname(hostname)) return { localOnly: true };
    return { remoteAllowed: true };
  } catch {
    return {};
  }
}

/**
 * Assemble canonical capability evidence for one `provider/model` candidate.
 * Sources (in priority order): provider config maps, provider registry hints,
 * cached Codex catalog row, native-model metadata.
 */
export function candidateCapabilityEvidence(
  config: OcxConfig,
  providerName: string,
  modelId: string,
): RouteCapabilityEvidence {
  const provider = config.providers[providerName];
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);
  const isNative = providerName === "openai" && !modelId.includes("/");

  const contextWindow = provider?.modelContextWindows?.[modelId]
    ?? provider?.contextWindow
    ?? registryEntry?.modelContextWindows?.[modelId]
    ?? catalogRow?.contextWindow
    ?? (isNative ? nativeOpenAiContextWindow(modelId) : undefined);

  const modalities = provider?.modelInputModalities?.[modelId]
    ?? registryEntry?.modelInputModalities?.[modelId]
    ?? catalogRow?.inputModalities
    ?? (isNative ? nativeInputModalities(modelId) : undefined);
  const image = Array.isArray(modalities)
    ? modalities.includes("image")
    : undefined;

  const capabilities = catalogRow?.capabilities ?? [];
  const tools = capabilities.includes("tools")
    || (isNative ? true : provider?.parallelToolCalls === true)
    || undefined;

  const reasoningEfforts = provider?.modelReasoningEfforts?.[modelId]
    ?? registryEntry?.modelReasoningEfforts?.[modelId]
    ?? catalogRow?.reasoningEfforts
    ?? (isNative ? nativeReasoningEfforts(modelId) : undefined);

  const tierSupport = provider?.supportsServiceTier
    ?? registryEntry?.supportsServiceTier;
  const serviceTier = tierSupport === true
    ? "supported"
    : tierSupport === false ? "unsupported" : "unknown";

  const localRemote = localRemoteEvidence(provider?.baseUrl);
  const encryptedCodexTasks = isCanonicalOpenAiForwardProvider(
    provider ?? { adapter: "", authMode: undefined, baseUrl: undefined },
  );

  return {
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    ...(typeof image === "boolean" ? { image } : {}),
    ...(typeof tools === "boolean" ? { tools } : {}),
    ...(reasoningEfforts !== undefined && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(serviceTier !== "unknown" ? { serviceTier } : {}),
    ...localRemote,
    encryptedCodexTasks,
  };
}
