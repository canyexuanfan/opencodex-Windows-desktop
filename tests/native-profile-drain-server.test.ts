import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetMainCodexAccountIdentityTrackingForTests } from "../src/codex/account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import { clearMainAccountInfoCache } from "../src/codex/main-account-cache";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/quota";
import { clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  acquireNativeMainProfileDrain,
  resetLifecycleDrainStateForTests,
} from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let opencodexHome = "";
let codexHome = "";

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-main-drain-server-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-main-drain-codex-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "main-access", account_id: "main-account" } }),
  );
  clearAccountQuota();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLifecycleDrainStateForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  if (opencodexHome) rmSync(opencodexHome, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

describe("native main profile scoped server admission", () => {
  test("HTTP and Responses WebSocket keep Direct live while main Pool frames are rejected", async () => {
    let upstreamRequests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("chatgpt.com/backend-api/codex/responses")) {
        upstreamRequests += 1;
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const saveMode = (codexAccountMode: "direct" | "pool") => saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      websockets: true,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode,
        },
      },
      codexAccounts: [],
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      autoSwitchThreshold: 0,
    } as OcxConfig);
    const waitForFrame = (ws: WebSocket, needle: string) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`websocket timeout waiting for ${needle}`)), 2_000);
      const onMessage = (event: MessageEvent) => {
        const text = typeof event.data === "string" ? event.data : "";
        if (!text.includes(needle)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(text);
      };
      ws.addEventListener("message", onMessage);
    });

    saveMode("direct");
    let server: ReturnType<typeof startServer> | undefined = startServer(0);
    const drain = acquireNativeMainProfileDrain("test-switch");
    expect(drain).not.toBeNull();
    try {
      const directHttp = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });
      expect(directHttp.status).toBe(200);
      await directHttp.text();

      const wsUrl = new URL("/v1/responses", server.url);
      wsUrl.protocol = "ws:";
      const directWs = new WebSocket(wsUrl, { headers: { authorization: "Bearer caller-token" } } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        directWs.addEventListener("open", () => resolve(), { once: true });
        directWs.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const directTerminal = waitForFrame(directWs, "response.completed");
      directWs.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      await directTerminal;
      directWs.close();
      await server.stop(true);
      server = undefined;

      saveMode("pool");
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 1, 1);
      server = startServer(0);
      const mainHttp = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });
      expect(mainHttp.status).toBe(503);
      expect(mainHttp.headers.get("retry-after")).toBe("1");

      const mainWsUrl = new URL("/v1/responses", server.url);
      mainWsUrl.protocol = "ws:";
      const mainWs = new WebSocket(mainWsUrl, { headers: { authorization: "Bearer caller-token" } } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        mainWs.addEventListener("open", () => resolve(), { once: true });
        mainWs.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const mainRejected = waitForFrame(mainWs, "main profile is switching");
      mainWs.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      expect(await mainRejected).toContain("503");
      mainWs.close();

      expect(upstreamRequests).toBe(2);
    } finally {
      drain?.release();
      await server?.stop(true);
    }
  });
});
