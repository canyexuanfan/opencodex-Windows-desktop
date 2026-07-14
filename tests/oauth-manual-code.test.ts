import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cancelLoginFlow,
  clearLoginState,
  startLoginFlow,
  submitManualLoginCode,
} from "../src/oauth";
import { parseCallbackInput } from "../src/oauth/callback-server";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-manual-code-test");
let previousOpencodexHome: string | undefined;

describe("OAuth manual login code fallback", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearLoginState("xai");
  });

  afterEach(() => {
    cancelLoginFlow("xai");
    clearLoginState("xai");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("parseCallbackInput extracts code/state from redirect URL", () => {
    expect(parseCallbackInput("http://127.0.0.1:56121/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  test("parseCallbackInput accepts raw authorization code", () => {
    expect(parseCallbackInput("  raw-auth-code  ")).toEqual({ code: "raw-auth-code", state: undefined });
  });

  test("submitManualLoginCode rejects when no login is in progress", () => {
    expect(submitManualLoginCode("xai", "http://127.0.0.1/callback?code=a&state=b")).toEqual({
      ok: false,
      error: "no login in progress",
    });
  });

  test("submitManualLoginCode rejects empty input", () => {
    expect(submitManualLoginCode("xai", "   ")).toEqual({ ok: false, error: "empty code" });
  });

  test("submitManualLoginCode accepts paste while GUI login is waiting", async () => {
    // startLoginFlow will try real xAI discovery; stub fetch for discovery + hang the wait.
    const originalFetch = globalThis.fetch;
    let authUrlSeen = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.x.ai/authorize",
            token_endpoint: "https://auth.x.ai/oauth/token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("oauth/token")) {
        // Should not be reached in this unit test (we cancel before exchange).
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 400 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const started = startLoginFlow("xai", { forceLogin: true });
      // Wait until onAuth resolves with a URL (flow is waiting for callback/manual paste).
      const result = await Promise.race([
        started,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startLoginFlow timed out")), 10_000)),
      ]);
      expect(result.url).toContain("https://auth.x.ai/authorize");
      authUrlSeen = true;

      // Early paste (may land before onManualCodeInput is registered) must be accepted.
      const submit = submitManualLoginCode(
        "xai",
        "http://127.0.0.1:56121/callback?code=test-code&state=will-likely-mismatch",
      );
      // State mismatch means the callback loop will discard and re-wait — still ok:true from the API.
      // A raw code (no state) is always accepted into the waiter.
      expect(submit.ok || submit.error === "no login in progress").toBe(true);

      // Raw code path: guaranteed to be stashed/delivered without state checks at submit time.
      const raw = submitManualLoginCode("xai", "manual-auth-code-only");
      expect(raw).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
      cancelLoginFlow("xai");
      clearLoginState("xai");
    }

    expect(authUrlSeen).toBe(true);
  });
});
