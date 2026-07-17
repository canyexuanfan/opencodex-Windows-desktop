import { resolveEnvValue } from "../config";
import {
  headersForCodexAuthContext,
  hasCallerCodexBearer,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
import { recordCodexUpstreamOutcome, type CodexUpstreamOutcome } from "../codex/routing";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../server/auth-cors";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import {
  isCanonicalOpenAiForwardProvider,
  OPENAI_API_PROVIDER_ID,
  OPENAI_DIRECT_PROVIDER_ID,
  OPENAI_MULTI_PROVIDER_ID,
} from "./openai-tiers";

export interface OpenAiForwardSidecarCandidate {
  providerName: typeof OPENAI_DIRECT_PROVIDER_ID | typeof OPENAI_MULTI_PROVIDER_ID;
  provider: OcxProviderConfig;
  accountMode: CodexAccountMode;
}

export interface ResolvedOpenAiForwardSidecar extends OpenAiForwardSidecarCandidate {
  authContext: CodexAuthContext;
  headers: Headers;
  recordOutcome?: (outcome: CodexUpstreamOutcome) => void;
}

export interface OpenAiImagesProviderSelection {
  forwardCandidates: OpenAiForwardSidecarCandidate[];
  keyed?: {
    providerName: typeof OPENAI_API_PROVIDER_ID;
    provider: OcxProviderConfig;
    apiKey: string;
  };
}

export function listOpenAiForwardSidecarCandidates(config: OcxConfig): OpenAiForwardSidecarCandidate[] {
  const rows: OpenAiForwardSidecarCandidate[] = [];
  for (const [providerName, accountMode] of [
    [OPENAI_DIRECT_PROVIDER_ID, "direct"],
    [OPENAI_MULTI_PROVIDER_ID, "pool"],
  ] as const) {
    const provider = config.providers[providerName];
    if (!provider || provider.disabled === true || !isCanonicalOpenAiForwardProvider(provider)) continue;
    rows.push({ providerName, provider, accountMode });
  }
  return rows;
}

export async function resolveFirstUsableOpenAiSidecar(
  candidates: readonly OpenAiForwardSidecarCandidate[],
  incomingHeaders: Headers,
  config: OcxConfig,
): Promise<ResolvedOpenAiForwardSidecar | undefined> {
  let callerBearerMayBeForwarded = true;
  try {
    validateForwardAdmissionCredential(incomingHeaders, config);
  } catch (error) {
    if (!(error instanceof ForwardAdmissionCredentialError)) throw error;
    callerBearerMayBeForwarded = false;
  }
  for (const candidate of candidates) {
    if (candidate.accountMode === "direct" && (!callerBearerMayBeForwarded || !hasCallerCodexBearer(incomingHeaders))) continue;
    const authContext = await resolveCodexAuthContext(incomingHeaders, config, candidate.accountMode);
    if (!isCodexAuthContextUsable(authContext, config)) continue;
    return {
      ...candidate,
      authContext,
      headers: headersForCodexAuthContext(incomingHeaders, authContext),
      ...(authContext.kind === "pool" || authContext.kind === "main-pool"
        ? { recordOutcome: (outcome: CodexUpstreamOutcome) => recordCodexUpstreamOutcome(config, authContext.accountId, outcome) }
        : {}),
    };
  }
  return undefined;
}

export function selectOpenAiImagesProvider(config: OcxConfig): OpenAiImagesProviderSelection {
  const selection: OpenAiImagesProviderSelection = {
    forwardCandidates: listOpenAiForwardSidecarCandidates(config),
  };
  const provider = config.providers[OPENAI_API_PROVIDER_ID];
  if (
    provider
    && provider.disabled !== true
    && provider.adapter === "openai-responses"
    && provider.authMode !== "forward"
    && provider.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"
  ) {
    const apiKey = resolveEnvValue(provider.apiKey)?.trim();
    if (apiKey) selection.keyed = { providerName: OPENAI_API_PROVIDER_ID, provider, apiKey };
  }
  return selection;
}
