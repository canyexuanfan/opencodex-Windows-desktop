import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";

// Phase 2 of devlog/model_update/260709_model_refresh: live /models discovery is the
// authoritative lineup; static config lists are the fallback seed. These tests pin the
// merge/fallback contract of fetchProviderModels through the public gatherRoutedModels seam.

const PROVIDER = "xai-live-test";

function config(): OcxConfig {
  return {
    providers: {
      [PROVIDER]: {
        baseUrl: "https://api.x.ai/v1",
        adapter: "openai-chat",
        authMode: "key",
        apiKey: "sk-test",
        models: ["grok-4.5", "grok-4.3"],
        modelContextWindows: { "grok-4.5": 500_000 },
      },
    },
  } as unknown as OcxConfig;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache(PROVIDER);
});

describe("live provider model discovery (merge + fallback)", () => {
  test("live /models ids merge with configured statics; live-only ids appear; dedupe holds", async () => {
    let requested: { url: string; auth: string | undefined } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requested = {
        url: String(url),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      };
      return new Response(JSON.stringify({
        data: [
          { id: "grok-4.5", context_length: 500_000 },
          { id: "grok-5-preview", context_length: 1_000_000 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const models = await gatherRoutedModels(config());
    const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);

    expect(requested?.url).toBe("https://api.x.ai/v1/models");
    expect(requested?.auth).toBe("Bearer sk-test");
    // Live grok-4.5 dedupes against the configured static; grok-5-preview is live-only;
    // grok-4.3 survives as a config-merge addition.
    expect(ids.sort()).toEqual(["grok-4.3", "grok-4.5", "grok-5-preview"]);
    // Live context_length flows into catalog metadata for live-only models.
    expect(models.find(m => m.provider === PROVIDER && m.id === "grok-5-preview")?.contextWindow)
      .toBe(1_000_000);
    expect(models.find(m => m.provider === PROVIDER && m.id === "grok-4.5")?.contextWindow)
      .toBe(500_000);
  });

  test("fetch failure falls back to the configured static list", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const models = await gatherRoutedModels(config());
    const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);

    expect(ids.sort()).toEqual(["grok-4.3", "grok-4.5"]);
    expect(models.find(m => m.provider === PROVIDER && m.id === "grok-4.5")?.contextWindow)
      .toBe(500_000);
  });

  test("non-ok response also falls back to statics (and cooldown clears via clearModelCache)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    const models = await gatherRoutedModels(config());
    const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);
    expect(ids.sort()).toEqual(["grok-4.3", "grok-4.5"]);
  });
});
