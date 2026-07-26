import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
const globals = ["document", "window", "navigator", "sessionStorage", "fetch"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let originalPrompt: typeof window.prompt;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: testWindow.fetch.bind(testWindow) },
  });
  originalPrompt = window.prompt;
  resetApiAuthFetchForTests();
  sessionStorage.clear();
});

afterEach(() => {
  window.prompt = originalPrompt;
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function installMockAuthFetch(handler: typeof fetch): Promise<void> {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: handler });
  Object.defineProperty(window, "fetch", { configurable: true, value: handler });
  installApiAuthFetch();
  // installApiAuthFetch replaces window.fetch — keep globalThis in sync for bare `fetch()`.
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
}

test("installApiAuthFetch deletes legacy sessionStorage token without reading it", () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");
  let getItemCalls = 0;
  const storage = sessionStorage;
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = ((key: string) => {
    getItemCalls += 1;
    return originalGetItem(key);
  }) as typeof storage.getItem;

  try {
    installApiAuthFetch();
    expect(getItemCalls).toBe(0);
    expect(originalGetItem(LEGACY_TOKEN_KEY)).toBeNull();
  } finally {
    storage.getItem = originalGetItem;
  }
});

test("prompted API tokens stay memory-only and are not written to sessionStorage", async () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");

  let authorized = false;
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "fresh-token") {
      authorized = true;
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => "fresh-token";

  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(authorized).toBe(true);
  expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
  expect(sessionStorage.length).toBe(0);
});

test("cross-origin /api/* requests do not receive the API key or token prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/api/config");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

test("cross-origin /v1/* requests do not receive the API key or token prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/v1/models")).status).toBe(200);
  expect(promptCalls).toBe(1);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/v1/models");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});
