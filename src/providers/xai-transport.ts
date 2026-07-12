import type { OcxProviderConfig } from "../types";

/**
 * xAI account OAuth and xAI API keys share a bearer shape but not a billing
 * transport. OAuth represents the Grok CLI subscription entitlement, while a
 * key represents the API team. Keep the saved provider preset compatible with
 * the dashboard's "Use an API key instead" switch and resolve the transport at
 * request time.
 */
export const XAI_GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Minimum-compatible official Grok CLI wire version verified with the proxy. */
export const XAI_GROK_CLIENT_VERSION = "0.2.93";

const XAI_GROK_CLI_HEADERS: Readonly<Record<string, string>> = {
  "x-grok-client-identifier": "opencodex",
  "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
  "x-xai-token-auth": "xai-grok-cli",
};

/**
 * Resolve the effective xAI transport without mutating persisted config.
 * User-provided headers are preserved and may advance the compatibility
 * version without waiting for an opencodex release.
 */
export function resolveProviderTransport(
  providerName: string,
  provider: OcxProviderConfig,
): OcxProviderConfig {
  if (providerName !== "xai" || provider.authMode !== "oauth") return provider;
  return {
    ...provider,
    baseUrl: XAI_GROK_CLI_BASE_URL,
    headers: {
      ...XAI_GROK_CLI_HEADERS,
      ...(provider.headers ?? {}),
    },
  };
}
