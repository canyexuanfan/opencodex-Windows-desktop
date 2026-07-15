import { describe, expect, test, mock, beforeEach } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveFeaturedProviderIds } from "../src/providers/derive";
import {
  generateMimoFingerprint,
  getMimoJwt,
  injectMimoSystemMarker,
  resetMimoJwtCache,
  MIMO_SYSTEM_MARKER,
  MIMO_CHAT_URL,
  createMimoFreeAdapter,
} from "../src/adapters/mimo-free";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalRequest(model = "mimo-auto"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: {},
  };
}

describe("mimo-free provider registry", () => {
  const entry = PROVIDER_REGISTRY.find(e => e.id === "mimo-free");

  test("registry entry exists with correct shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("mimo-free");
    expect(entry?.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
    expect(entry?.authKind).toBe("key");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.liveModels).toBe(true);
    expect(entry?.defaultModel).toBe("mimo-auto");
  });

  test("providerConfigSeed propagates keyOptional and liveModels", () => {
    const seed = providerConfigSeed(entry!);
    expect(seed.keyOptional).toBe(true);
    expect(seed.liveModels).toBe(true);
  });

  test("is included in the key-login map", () => {
    const keyMap = deriveKeyLoginMap();
    expect(keyMap["mimo-free"]).toBeDefined();
  });

  test("is in the featured provider list", () => {
    expect(deriveFeaturedProviderIds()).toContain("mimo-free");
  });

  test("provider note mentions no key needed", () => {
    expect(entry?.note?.toLowerCase()).toContain("no key needed");
  });
});

describe("mimo-free system marker injection", () => {
  test("prepends marker when no system message is present", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: { role: string; content: string }[] };
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    expect(result.messages[1]?.role).toBe("user");
  });

  test("prepends marker when system message does not contain it", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: { role: string; content: string }[] };
    expect(result.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    expect(result.messages).toHaveLength(3);
  });

  test("is idempotent when marker is already present", () => {
    const body = { messages: [{ role: "system", content: `${MIMO_SYSTEM_MARKER} extra` }, { role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: unknown[] };
    expect(result.messages).toHaveLength(2);
  });

  test("passes through non-object bodies unchanged", () => {
    expect(injectMimoSystemMarker(null)).toBeNull();
    expect(injectMimoSystemMarker("string")).toBe("string");
  });

  test("passes through body without messages unchanged", () => {
    const body = { model: "mimo-auto" };
    expect(injectMimoSystemMarker(body)).toEqual({ model: "mimo-auto" });
  });
});

describe("mimo-free fingerprint", () => {
  test("generateMimoFingerprint returns a 64-char hex string", () => {
    const fp = generateMimoFingerprint();
    expect(typeof fp).toBe("string");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fingerprint is stable across calls", () => {
    expect(generateMimoFingerprint()).toBe(generateMimoFingerprint());
  });
});

describe("mimo-free JWT cache", () => {
  beforeEach(() => {
    resetMimoJwtCache();
  });

  test("getMimoJwt fetches from bootstrap and caches", async () => {
    const fakeJwt = "header." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".sig";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      const jwt1 = await getMimoJwt();
      expect(jwt1).toBe(fakeJwt);
      // Second call should use cache — fetch called only once
      const jwt2 = await getMimoJwt();
      expect(jwt2).toBe(fakeJwt);
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("getMimoJwt throws when bootstrap returns error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response("", { status: 503 }));
    try {
      await expect(getMimoJwt()).rejects.toThrow("MiMo bootstrap failed: 503");
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("resetMimoJwtCache forces re-fetch on next call", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      await getMimoJwt();
      resetMimoJwtCache();
      await getMimoJwt();
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });
});

describe("mimo-free adapter request building", () => {
  beforeEach(() => {
    resetMimoJwtCache();
  });

  test("buildRequest sets correct URL, headers, and injects system marker", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      const provider: OcxProviderConfig = providerConfigSeed(PROVIDER_REGISTRY.find(e => e.id === "mimo-free")!);
      const adapter = createMimoFreeAdapter(provider);
      const req = await adapter.buildRequest(minimalRequest());
      const headers = req.headers as Record<string, string>;

      expect(req.url).toBe(MIMO_CHAT_URL);
      expect(headers["Authorization"]).toBe(`Bearer ${fakeJwt}`);
      expect(headers["X-Mimo-Source"]).toBe("mimocode-cli-free");
      expect(headers["x-session-affinity"]).toMatch(/^ses_/);

      const body = JSON.parse(req.body as string) as { messages: { role: string; content: string }[] };
      expect(body.messages[0]?.role).toBe("system");
      expect(body.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });
});

describe("mimo-free GUI preset", () => {
  test("deriveProviderPresets exposes keyOptional for picker", () => {
    const { deriveProviderPresets } = require("../src/providers/derive");
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "mimo-free");
    expect(preset).toBeDefined();
    expect(preset.keyOptional).toBe(true);
    expect(preset.note).toMatch(/no key needed/i);
  });
});
