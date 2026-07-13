export interface ProviderPayloadForm {
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth" | "local";
  apiKey: string;
  defaultModel: string;
}

export interface ProviderPayload {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth";
}

export function buildProviderPayload(form: ProviderPayloadForm): ProviderPayload {
  const provider: ProviderPayload = {
    adapter: form.adapter.trim(),
    baseUrl: form.baseUrl.trim(),
  };

  if (form.authMode === "key" || form.authMode === "forward") {
    provider.authMode = form.authMode;
  }
  if (form.authMode === "key" && form.apiKey.trim()) {
    provider.apiKey = form.apiKey.trim();
  }
  if (form.defaultModel.trim()) {
    provider.defaultModel = form.defaultModel.trim();
  }

  return provider;
}
