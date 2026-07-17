import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
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

export function builtInCodexAccountMode(providerName: string): CodexAccountMode | undefined {
  if (providerName === OPENAI_DIRECT_PROVIDER_ID) return "direct";
  if (providerName === OPENAI_MULTI_PROVIDER_ID) return "pool";
  return undefined;
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

function isExactCanonicalCodexForwardProvider(provider: OcxProviderConfig): boolean {
  const keys = Object.keys(provider).sort();
  return keys.length === 3
    && keys[0] === "adapter"
    && keys[1] === "authMode"
    && keys[2] === "baseUrl"
    && isCanonicalOpenAiForwardProvider(provider);
}

export function projectOpenAiTierMigration(config: OcxConfig): OpenAiTierMigrationProjection {
  const projected = structuredClone(config);
  const legacyPoolIntent = (projected.codexAccounts?.length ?? 0) > 0
    || typeof projected.activeCodexAccountId === "string";

  if (projected.openaiProviderTierVersion === OPENAI_PROVIDER_TIER_VERSION) {
    return { config: projected, changed: false, legacyPoolIntent };
  }

  const existingMulti = projected.providers[OPENAI_MULTI_PROVIDER_ID];
  if (existingMulti && !isExactCanonicalCodexForwardProvider(existingMulti)) {
    throw new OpenAiTierMigrationCollisionError();
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
      nextEntries.push([name, canonicalCodexForwardProvider()]);
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
