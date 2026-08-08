import type { OcxProviderConfig } from "../../types";

export function fixtureProviderConfig(adapter: string): OcxProviderConfig {
  return {
    adapter,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fixture-key",
    allowPrivateNetwork: true,
    models: ["fixture-model"],
    defaultModel: "fixture-model",
    liveModels: false,
  };
}

export function upstreamAdapterForProtocol(protocol: string): string {
  switch (protocol) {
    case "openai-chat":
      return "openai-chat";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    case "cursor-protobuf":
      return "cursor";
    default:
      return "openai-chat";
  }
}
