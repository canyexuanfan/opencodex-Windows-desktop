import { afterEach, describe, expect, test } from "bun:test";
import { refreshChatGPTToken } from "../src/oauth/chatgpt";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("ChatGPT OAuth token response parsing", () => {
  test("refresh with a non-finite expires_in falls back to a finite default expiry", async () => {
    globalThis.fetch = (async () => new Response(
      // JSON.stringify would turn Infinity into null; hand-write 1e999 so JSON.parse
      // yields Infinity, which ?? 3600 alone would let through (NaN expiry, never refreshing).
      '{"access_token":"at","refresh_token":"rt","expires_in":1e999}',
      { status: 200 },
    )) as typeof fetch;

    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(Date.now());
  });

  test("refresh with a string expires_in falls back to a finite default expiry", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: "garbage" }),
      { status: 200 },
    )) as typeof fetch;

    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(Date.now());
  });
});
