import { describe, expect, test } from "bun:test";
import { providerFetch, withUpstreamHttpVersion } from "../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../src/types";

const HTTPS_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const HTTP_URL = "http://127.0.0.1:10900/zen/go/v1/chat/completions";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    ...overrides,
  };
}

describe("withUpstreamHttpVersion", () => {
  test("absent upstreamHttpVersion keeps the init untouched", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTPS_URL, init, provider())).toBe(init);
  });

  test("auto keeps the init untouched (default negotiation)", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTPS_URL, init, provider({ upstreamHttpVersion: "auto" }))).toBe(init);
  });

  test("undefined init stays undefined", () => {
    expect(withUpstreamHttpVersion(HTTPS_URL, undefined, provider({ upstreamHttpVersion: "http1.1" }))).toBeUndefined();
  });

  test("http1.1 pins the protocol on https targets", () => {
    const init = { method: "POST", headers: {} };
    const out = withUpstreamHttpVersion(HTTPS_URL, init, provider({ upstreamHttpVersion: "http1.1" }))!;
    expect(out).not.toBe(init);
    expect((out as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
  });

  test("h1/h2/http2 map through to Bun protocol values", () => {
    for (const [version, expected] of [
      ["h1", "h1"],
      ["http2", "http2"],
      ["h2", "h2"],
    ] as const) {
      const out = withUpstreamHttpVersion(
        HTTPS_URL,
        { method: "POST" },
        provider({ upstreamHttpVersion: version }),
      )!;
      expect((out as RequestInit & { protocol?: string }).protocol).toBe(expected);
    }
  });

  test("plain-http targets are left untouched (Bun protocol requires https)", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTP_URL, init, provider({ upstreamHttpVersion: "http1.1" }))).toBe(init);
  });

  test("Request objects resolve their url for the https guard", () => {
    const request = new Request(HTTPS_URL);
    const init = { method: "POST" };
    const out = withUpstreamHttpVersion(request, init, provider({ upstreamHttpVersion: "http1.1" }))!;
    expect((out as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
  });

  test("unparseable targets degrade to the untouched init", () => {
    const init = { method: "POST" };
    expect(withUpstreamHttpVersion("not a url", init, provider({ upstreamHttpVersion: "http1.1" }))).toBe(init);
  });
});

describe("providerFetch upstreamHttpVersion propagation", () => {
  test("a provider-pinned version reaches the underlying fetch call", async () => {
    let seenInit: RequestInit | undefined;
    const stubFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return new Response("ok");
    };
    const fetcher = providerFetch(provider({
      upstreamHttpVersion: "http1.1",
      fetch: stubFetch,
    }));
    await fetcher(HTTPS_URL, { method: "POST", body: "{}" });
    expect((seenInit as RequestInit & { protocol?: string })?.protocol).toBe("http1.1");
  });

  test("no pin keeps the caller init verbatim", async () => {
    let seenInit: RequestInit | undefined;
    const stubFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return new Response("ok");
    };
    const fetcher = providerFetch(provider({ fetch: stubFetch }));
    await fetcher(HTTPS_URL, { method: "POST", body: "{}" });
    expect(seenInit).toEqual({ method: "POST", body: "{}" });
  });
});
