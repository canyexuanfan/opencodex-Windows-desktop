import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Storage from "../src/pages/Storage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const REPORT = {
  codexHome: "/tmp/codex",
  generatedAt: 1,
  total: { bytes: 100, fileCount: 1 },
  buckets: [{ key: "archived_sessions", label: "Archived", bytes: 100, fileCount: 1 }],
};

const POLICY = {
  enabled: true,
  trigger: { archivedBytesOver: 0 },
  target: { removeOldestPercent: 25 },
  schedule: "manual",
  mode: "quarantine",
} as const;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("storage policy run warns when cleanup succeeds but metadata persistence fails", async () => {
  const startedAt = 10;
  let started = false;
  let storageFetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/storage/cleanup-policy/run") && method === "POST") {
      started = true;
      return Response.json({
        ok: true,
        started: true,
        job: { status: "running", startedAt },
        policy: { ...POLICY, job: { status: "running", startedAt } },
      });
    }
    if (url.endsWith("/api/storage/cleanup-policy") && method === "PUT") {
      return Response.json({ ok: true, policy: POLICY });
    }
    if (url.endsWith("/api/storage/cleanup-policy")) {
      if (!started) return Response.json(POLICY);
      return Response.json({
        ...POLICY,
        job: {
          status: "idle",
          startedAt,
          finishedAt: startedAt + 1,
          lastOutcome: {
            ok: true,
            mode: "quarantine",
            removed: 1,
            freedBytes: 100,
            metadataPersistenceError: "missing",
          },
        },
      });
    }
    if (url.endsWith("/api/storage/trash")) return Response.json({ entries: [] });
    if (url.endsWith("/api/storage")) {
      storageFetches += 1;
      return Response.json(REPORT);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Storage apiBase="http://localhost" /></LanguageProvider>);
    });
    await waitFor(() => Array.from(container.querySelectorAll("button")).some(button => button.textContent?.includes("Run now")));
    const runButton = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.includes("Run now"));
    expect(runButton).toBeDefined();

    await act(async () => {
      runButton!.click();
    });
    await waitFor(() => (container.textContent ?? "").includes("scheduling metadata could not be saved"));
    await waitFor(() => storageFetches >= 2);

    expect(container.textContent).not.toContain("Policy quarantined");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("scheduling metadata could not be saved");
    expect(storageFetches).toBeGreaterThanOrEqual(2);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
