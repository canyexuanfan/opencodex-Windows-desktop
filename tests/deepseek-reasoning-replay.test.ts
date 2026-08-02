/**
 * Issue #875 (local half): DeepSeek's Responses API accepts plaintext reasoning
 * replay (its compatibility guide merges reasoning items into the adjacent
 * assistant message), but the passthrough serializer blanked reasoning `content`
 * for EVERY provider — a rule only the ChatGPT native backend needs. Providers
 * flagged `preserveResponsesReasoningContent` now keep valid replay content while
 * still stripping proxy-minted `ocxr1` envelopes no upstream can decrypt.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, sanitizeReasoningInputContent } from "../src/adapters/openai-responses";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { OCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const reasoningItem = (extra: Record<string, unknown> = {}) => ({
  type: "reasoning",
  id: "rs_1",
  content: [{ type: "reasoning_text", text: "think step by step" }],
  ...extra,
});

function inputOf(result: unknown): Record<string, unknown>[] {
  return (result as { input: Record<string, unknown>[] }).input;
}

describe("sanitizeReasoningInputContent scoping", () => {
  test("default behavior still blanks reasoning content (ChatGPT backend rule)", () => {
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }));
    expect(out[0]!.content).toEqual([]);
  });

  test("preservation keeps plaintext reasoning content", () => {
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }, { preserveRawReasoningContent: true }));
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("preservation still strips an ocxr1 envelope but keeps the plaintext content", () => {
    const item = reasoningItem({ encrypted_content: `${OCX_REASONING_PREFIX}Zm9v` });
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [item] }, { preserveRawReasoningContent: true }));
    expect("encrypted_content" in out[0]!).toBe(false);
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("default behavior strips the envelope AND blanks content", () => {
    const item = reasoningItem({ encrypted_content: `${OCX_REASONING_PREFIX}Zm9v` });
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [item] }));
    expect("encrypted_content" in out[0]!).toBe(false);
    expect(out[0]!.content).toEqual([]);
  });
});

describe("DeepSeek Responses replay keeps reasoning on the wire", () => {
  function buildBody(provider: OcxProviderConfig): Record<string, unknown> {
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "deepseek-v4-flash", input: [reasoningItem()] },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return JSON.parse(String(built.body)) as Record<string, unknown>;
  }

  test("a DeepSeek continuation keeps reasoning_text", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    const body = buildBody(provider);
    const item = (body.input as Record<string, unknown>[])[0]!;
    expect(item.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("a canonical OpenAI provider still blanks reasoning content", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" };
    const body = buildBody(provider);
    const item = (body.input as Record<string, unknown>[])[0]!;
    expect(item.content).toEqual([]);
  });
});
