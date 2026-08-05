import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval",
] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: () => 1 },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models: [
      { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false },
      { provider: "anthropic", id: "claude-opus-4-5", namespaced: "anthropic/claude-opus-4-5", disabled: false },
    ],
    providers: [{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5", "claude-opus-4-5"] }],
    selectedModels: {},
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) {
      return Response.json([
        { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false },
        { provider: "anthropic", id: "claude-opus-4-5", namespaced: "anthropic/claude-opus-4-5", disabled: false },
      ]);
    }
    if (url.endsWith("/api/providers")) return Response.json([{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5", "claude-opus-4-5"] }]);
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  clearClientResourceStoresForTests();
  try {
    if (root) {
      const current = root;
      await act(async () => { current.unmount(); });
    }
  } finally {
    root = null;
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("apply feedback renders as a fixed toast, not an inline notice before the workspace", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  // Hide the whole provider group, the same action that used to pop the inline notice.
  await act(async () => {
    const off = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "All off")!;
    off.click();
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  const toast = container.querySelector<HTMLElement>(".action-toast");
  expect(toast).not.toBeNull();
  expect(toast!.className).toContain("notice-ok");
  expect(toast!.getAttribute("role")).toBe("status");
  expect(toast!.textContent).toContain("Applied");
  // No inline notice sits in the flow before the workspace anymore.
  const workspace = container.querySelector<HTMLElement>(".models-workspace-root");
  expect(workspace?.previousElementSibling?.classList.contains("action-toast")).toBe(true);
});
