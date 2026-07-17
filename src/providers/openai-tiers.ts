import type { OcxConfig, OcxProviderConfig } from "../types";
import { OPENAI_PROVIDER_TIER_VERSION } from "../types";

export const OPENAI_DIRECT_PROVIDER_ID = "openai";
export const OPENAI_MULTI_PROVIDER_ID = "openai-multi";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";
export const LEGACY_CHATGPT_PROVIDER_ID = "chatgpt";

const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

function canonicalCodexForwardProvider(): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: CODEX_FORWARD_BASE_URL,
    authMode: "forward",
  };
}

function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}

export interface OpenAiTierMigrationProjection {
  config: OcxConfig;
  changed: boolean;
  legacyPoolIntent: boolean;
}

export class OpenAiTierMigrationCollisionError extends Error {
  readonly providerName = OPENAI_MULTI_PROVIDER_ID;

  constructor() {
    super(`Reserved provider id "${OPENAI_MULTI_PROVIDER_ID}" is already configured with a noncanonical shape`);
    this.name = "OpenAiTierMigrationCollisionError";
  }
}

function managedMultiOverlay(provider: OcxProviderConfig): Pick<OcxProviderConfig, "disabled" | "selectedModels"> | null {
  const allowed = new Set(["adapter", "authMode", "baseUrl", "disabled", "selectedModels"]);
  if (!Object.keys(provider).every(key => allowed.has(key))) return null;
  if (!isCanonicalOpenAiForwardProvider(provider)) return null;
  if (provider.disabled !== undefined && typeof provider.disabled !== "boolean") return null;
  if (provider.selectedModels !== undefined && (
    !Array.isArray(provider.selectedModels)
    || provider.selectedModels.some(model => typeof model !== "string")
  )) return null;
  return {
    ...(provider.disabled !== undefined ? { disabled: provider.disabled } : {}),
    ...(provider.selectedModels !== undefined ? { selectedModels: [...provider.selectedModels] } : {}),
  };
}

export function projectOpenAiTierMigration(config: OcxConfig): OpenAiTierMigrationProjection {
  const projected = structuredClone(config);
  const legacyPoolIntent = (projected.codexAccounts?.length ?? 0) > 0
    || typeof projected.activeCodexAccountId === "string";

  const existingMulti = projected.providers[OPENAI_MULTI_PROVIDER_ID];
  const multiOverlay = existingMulti ? managedMultiOverlay(existingMulti) : undefined;
  if (existingMulti && !multiOverlay) {
    throw new OpenAiTierMigrationCollisionError();
  }

  if (projected.openaiProviderTierVersion === OPENAI_PROVIDER_TIER_VERSION) {
    let changed = false;
    if (existingMulti) {
      const repairedMulti = { ...canonicalCodexForwardProvider(), ...(multiOverlay ?? {}) };
      if (JSON.stringify(existingMulti) !== JSON.stringify(repairedMulti)) {
        projected.providers[OPENAI_MULTI_PROVIDER_ID] = repairedMulti;
        changed = true;
      }
    }
    if (Object.hasOwn(projected.providers, LEGACY_CHATGPT_PROVIDER_ID)) {
      delete projected.providers[LEGACY_CHATGPT_PROVIDER_ID];
      changed = true;
      if (!projected.providers[OPENAI_DIRECT_PROVIDER_ID]) {
        projected.providers[OPENAI_DIRECT_PROVIDER_ID] = canonicalCodexForwardProvider();
      }
      if (legacyPoolIntent && !projected.providers[OPENAI_MULTI_PROVIDER_ID]) {
        projected.providers[OPENAI_MULTI_PROVIDER_ID] = canonicalCodexForwardProvider();
      }
    }
    if (projected.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID) {
      if (legacyPoolIntent && !projected.providers[OPENAI_MULTI_PROVIDER_ID]) {
        projected.providers[OPENAI_MULTI_PROVIDER_ID] = canonicalCodexForwardProvider();
      }
      projected.defaultProvider = legacyPoolIntent ? OPENAI_MULTI_PROVIDER_ID : OPENAI_DIRECT_PROVIDER_ID;
      changed = true;
    }
    return { config: projected, changed, legacyPoolIntent };
  }

  const previousDefault = projected.defaultProvider;
  const existingEntries = Object.entries(projected.providers)
    .filter(([name]) => name !== LEGACY_CHATGPT_PROVIDER_ID);
  const nextEntries: Array<[string, OcxProviderConfig]> = [];
  let directInserted = false;
  let multiInserted = false;

  for (const [name, provider] of existingEntries) {
    if (name === OPENAI_DIRECT_PROVIDER_ID) {
      nextEntries.push([name, canonicalCodexForwardProvider()]);
      directInserted = true;
      if (legacyPoolIntent && !Object.prototype.hasOwnProperty.call(projected.providers, OPENAI_MULTI_PROVIDER_ID)) {
        nextEntries.push([OPENAI_MULTI_PROVIDER_ID, canonicalCodexForwardProvider()]);
        multiInserted = true;
      }
      continue;
    }
    if (name === OPENAI_MULTI_PROVIDER_ID) {
      nextEntries.push([name, { ...canonicalCodexForwardProvider(), ...(multiOverlay ?? {}) }]);
      multiInserted = true;
      continue;
    }
    nextEntries.push([name, provider]);
  }

  if (!directInserted) nextEntries.push([OPENAI_DIRECT_PROVIDER_ID, canonicalCodexForwardProvider()]);
  if (legacyPoolIntent && !multiInserted) {
    nextEntries.push([OPENAI_MULTI_PROVIDER_ID, canonicalCodexForwardProvider()]);
  }

  projected.providers = Object.fromEntries(nextEntries);
  if (previousDefault === LEGACY_CHATGPT_PROVIDER_ID) {
    projected.defaultProvider = legacyPoolIntent ? OPENAI_MULTI_PROVIDER_ID : OPENAI_DIRECT_PROVIDER_ID;
  } else if (legacyPoolIntent && previousDefault === OPENAI_DIRECT_PROVIDER_ID) {
    projected.defaultProvider = OPENAI_MULTI_PROVIDER_ID;
  }
  projected.openaiProviderTierVersion = OPENAI_PROVIDER_TIER_VERSION;

  return { config: projected, changed: true, legacyPoolIntent };
}
