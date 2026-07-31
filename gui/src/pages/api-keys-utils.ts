export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface ApiEndpointInfo {
  baseUrl: string;
  responses: string;
  chatCompletions: string;
  messages: string;
  models: string;
}

export type ModelTestState = "idle" | "testing" | "ok" | "error";

export const DEFAULT_ENDPOINTS: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

export function deriveApiEndpoints(endpoint: string): ApiEndpointInfo {
  const responses = endpoint || DEFAULT_ENDPOINTS.responses;
  const match = responses.match(/^(.*)\/v1\/responses\/?$/);
  const baseUrl = match ? `${match[1]}/v1` : responses.replace(/\/responses\/?$/, "");
  return {
    baseUrl,
    responses,
    chatCompletions: `${baseUrl}/chat/completions`,
    messages: `${baseUrl}/messages`,
    models: `${baseUrl}/models`,
  };
}

export function formatCreatedDate(iso: string, localeTag?: string): string {
  // A hand-edited config can carry a non-string createdAt, which the server
  // salvages to "" rather than discarding a working key. Rendering that as
  // "Invalid Date" states something false about the key; an em dash says the
  // one true thing, which is that we do not know when it was created.
  const parsed = new Date(iso);
  if (!iso || Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(localeTag);
}
