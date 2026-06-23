import type { IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";

// Headers relayed verbatim from the caller in OAuth-passthrough ("forward") mode.
// Exported so the web-search sidecar reuses the exact same forwarded-auth set for its ChatGPT call.
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-responsesapi-include-timing-metrics",
];

function sanitizeReasoningInputContent(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.input)) return body;

  let changed = false;
  const input = raw.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "reasoning" || !Array.isArray(rec.content) || rec.content.length === 0) return item;
    changed = true;
    // Routed models can produce raw `reasoning_text` output items. Codex echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so native passthrough does not 400.
    return { ...rec, content: [] };
  });

  return changed ? { ...raw, input } : body;
}

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let url: string;

      if (provider.authMode === "forward") {
        // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
        url = `${provider.baseUrl}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        for (const h of FORWARD_HEADERS) {
          const v = incoming?.headers.get(h);
          if (v) headers[h] = v;                                        // …so forwarded auth always wins.
        }
        const override = (provider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
        if (override) {
          headers["authorization"] = `Bearer ${override.accessToken}`;
          headers["chatgpt-account-id"] = override.chatgptAccountId;
        }
      } else {
        const base = provider.baseUrl.replace(/\/v1\/?$/, "");
        url = `${base}/v1/responses`;
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }

      return {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(sanitizeReasoningInputContent(parsed._rawBody)),
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "passthrough adapter should not parse stream" };
    },
  };
}
