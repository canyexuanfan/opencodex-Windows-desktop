import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { routeModel } from "../../router";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  concreteComboRequestBody,
  getCombo,
  isComboTargetInCooldown,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseRetryAfterMs,
  pickComboTarget,
  targetKey,
} from "../../combos";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../responses-item-id-repair";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";


export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}



export const FERNET_TOKEN_RUN = /gAAAA[A-Za-z0-9_-]{60,}={0,2}/g;

export const AGENT_MESSAGE_ROUTING_ENVELOPE = /(?:^|\n)Message Type\s*:\s*NEW_TASK[^\n]*\nTask name\s*:[^\n]*\nSender\s*:[^\n]*\nPayload\s*:\s*(?:\n|$)/gi;

export const AGENT_MESSAGE_CONTROL_PREAMBLE = /(?:^|\n)\[CXC-(?:LEAF-GUARD|SKILL-AFFORDANCE)\][\s\S]*?(?=\n{2,}|$)/g;

export function hasUnreadableEncryptedAgentTask(input: unknown): boolean {
  if (!Array.isArray(input)) return false;

  return input.some(item => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "agent_message") {
      return false;
    }

    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;

    let hasFernetTask = false;
    const readableParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown; encrypted_content?: unknown };
      if (
        (record.type === "input_text" || record.type === "text" || record.type === "output_text")
        && typeof record.text === "string"
      ) {
        readableParts.push(record.text);
        continue;
      }
      if (record.type !== "encrypted_content" || typeof record.encrypted_content !== "string") {
        continue;
      }

      const withoutFernet = record.encrypted_content.replace(FERNET_TOKEN_RUN, "\n\n");
      if (withoutFernet !== record.encrypted_content) hasFernetTask = true;
      readableParts.push(withoutFernet);
    }

    if (!hasFernetTask) return false;
    const readableTask = readableParts
      .join("\n\n")
      .replace(AGENT_MESSAGE_ROUTING_ENVELOPE, "\n")
      .replace(AGENT_MESSAGE_CONTROL_PREAMBLE, "\n")
      .trim();
    return readableTask.length === 0;
  });
}



export function encryptedSlotParts(payload: string): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = [];
  let last = 0;
  for (const match of payload.matchAll(FERNET_TOKEN_RUN)) {
    const index = match.index ?? 0;
    const before = payload.slice(last, index);
    if (before.trim().length > 0) parts.push({ type: "input_text", text: before });
    parts.push({ type: "encrypted_content", encrypted_content: match[0] });
    last = index + match[0].length;
  }
  const rest = payload.slice(last);
  if (rest.trim().length > 0) parts.push({ type: "input_text", text: rest });
  return parts.length > 0 ? parts : [{ type: "input_text", text: payload }];
}



export function hasEncryptedContentPart(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => (
    part && typeof part === "object"
    && (part as { type?: unknown }).type === "encrypted_content"
  ));
}



export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  const visit = (node: unknown): number => {
    const before = rewritten;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const child = node[i] as unknown;
        if (
          child && typeof child === "object"
          && (child as { type?: unknown }).type === "encrypted_content"
          && typeof (child as { encrypted_content?: unknown }).encrypted_content === "string"
        ) {
          const payload = (child as { encrypted_content: string }).encrypted_content;
          if (!looksLikeBackendCiphertext(payload)) {
            const parts = encryptedSlotParts(payload);
            node.splice(i, 1, ...parts);
            i += parts.length - 1;
            rewritten += 1;
            continue;
          }
        }
        const childRewrites = visit(child);
        if (
          childRewrites > 0
          && child && typeof child === "object"
          && (child as { type?: unknown }).type === "agent_message"
          && !hasEncryptedContentPart((child as { content?: unknown }).content)
        ) {
          const message = child as { type: string; role?: string; id?: unknown; author?: unknown; recipient?: unknown };
          message.type = "message";
          message.role = "user";
          delete message.id;
          delete message.author;
          delete message.recipient;
        }
      }
      return rewritten - before;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) visit(value);
    }
    return rewritten - before;
  };
  visit(input);
  return rewritten;
}


