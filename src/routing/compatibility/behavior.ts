import type { OcxConfig, OcxProviderConfig } from "../../types";
import { PROVIDER_REGISTRY } from "../../providers/registry";
import { resolveWireProtocolOverride } from "../../server/adapter-resolve";
import type { LabBehaviorSource, LabBehaviorValues } from "../../lab/live/types";

export function upstreamProtocolForAdapter(adapter: string): string {
  switch (adapter) {
    case "openai-responses":
      return "openai-responses";
    case "openai-chat":
    case "command-code":
    case "cursor":
    case "azure":
    case "azure-openai":
    case "kiro":
    case "mimo-free":
      return "openai-chat";
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generate";
    default:
      return "openai-responses";
  }
}

export function surfaceForProtocols(inboundProtocol: string, upstreamProtocol: string): string {
  if (inboundProtocol === "anthropic-messages") return "anthropic-messages-http";
  if (upstreamProtocol === "anthropic-messages") return "responses-http";
  if (upstreamProtocol === "openai-chat") return "responses-sse";
  return "responses-http";
}

function behaviorRow(source: LabBehaviorSource, value: unknown) {
  return { source, value };
}

function includesModel(list: string[] | undefined, modelId: string): boolean {
  return Array.isArray(list) && list.includes(modelId);
}

/**
 * Production behavior resolver for route-subject fingerprinting.
 * Emits the closed keys required by `buildBehaviorFingerprintV1`.
 */
export function resolveProductionBehaviorValues(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundProtocol = "openai-responses",
): LabBehaviorValues | null {
  const provider = config.providers[providerName];
  if (!provider || provider.disabled === true) return null;
  const effective = resolveWireProtocolOverride(
    providerName,
    modelId,
    routed,
    "responses",
  );
  const adapter = effective.adapter ?? "openai-responses";
  const upstreamProtocol = upstreamProtocolForAdapter(adapter);
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);

  const authMode = effective.authMode ?? registryEntry?.authKind ?? "key";
  const authTransport = authMode === "oauth" ? "oauth_bearer" : "authorization_bearer";

  const values: LabBehaviorValues = {
    "wire.adapter": behaviorRow("provider_config", adapter),
    "wire.upstreamProtocol": behaviorRow("provider_config", upstreamProtocol),
    "auth.mode": behaviorRow("provider_config", authMode),
    "auth.transport": behaviorRow("provider_config", authTransport),
    "mcp.nativeLocalExec": behaviorRow("global_config", false),
    "runtime.bunVersion": behaviorRow("registry_runtime_default", Bun.version),
    "runtime.platform": behaviorRow("registry_runtime_default", process.platform),
    "runtime.arch": behaviorRow("registry_runtime_default", process.arch),
    "runtime.streamMode": behaviorRow("global_config", config.streamMode ?? "auto"),
    "runtime.fastMode": behaviorRow("global_config", config.fastMode === true),
    "runtime.effortCap": behaviorRow("global_config", config.effortCap ?? null),
    "headers.nonCredentialBehaviorDigest": behaviorRow(
      "provider_config",
      "0".repeat(64),
    ),
  };

  if (effective.responsesPath) {
    values["wire.responsesPath"] = behaviorRow("provider_config", effective.responsesPath);
  }
  if (effective.modelSuffixBracketStrip !== undefined) {
    values["wire.modelSuffixMode"] = behaviorRow("provider_config", effective.modelSuffixBracketStrip ? "bracket_strip" : "none");
  }
  if (effective.supportsServiceTier !== undefined) {
    values["responses.serviceTier"] = behaviorRow("provider_config", effective.supportsServiceTier);
  }
  if (effective.parallelToolCalls !== undefined) {
    values["tools.parallel"] = behaviorRow("provider_config", effective.parallelToolCalls);
  }
  if (effective.escapeBuiltinToolNames !== undefined) {
    values["tools.builtinNameEscaping"] = behaviorRow("provider_config", effective.escapeBuiltinToolNames);
  }
  if (includesModel(effective.noTemperatureModels, modelId)) {
    values["sampling.omitTemperature"] = behaviorRow("provider_config", true);
  }
  if (includesModel(effective.noTopPModels, modelId)) {
    values["sampling.omitTopP"] = behaviorRow("provider_config", true);
  }
  if (includesModel(effective.noPenaltyModels, modelId)) {
    values["sampling.omitPenalties"] = behaviorRow("provider_config", true);
  }
  if (includesModel(effective.noReasoningModels, modelId)) {
    values["reasoning.supported"] = behaviorRow("provider_config", false);
  } else if (registryEntry?.reasoningEfforts || effective.reasoningEfforts) {
    values["reasoning.supported"] = behaviorRow("provider_config", true);
  }

  void inboundProtocol;
  return values;
}

export function providerInstanceKey(
  providerName: string,
  routed: OcxProviderConfig,
): string {
  const baseUrl = typeof routed.baseUrl === "string" ? routed.baseUrl.trim() : "";
  const adapter = typeof routed.adapter === "string" ? routed.adapter : "";
  return `${providerName}\0${baseUrl}\0${adapter}`;
}
