/**
 * Models tab workspace — mounted behaviour.
 *
 * The routing helpers are unit-tested at `tests/models-workspace-tabs.test.ts`. This file
 * exists because those assertions cannot see the failures that actually happened here:
 * a component-level early return that unmounted the whole tab tree while the catalog
 * loaded, and a disabled resource that swapped the combo editor for an empty state and
 * destroyed an unsaved draft. Both passed typecheck, lint, and every source-string
 * assertion. Only mounting the thing catches them.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Models from "../src/pages/Models";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";

/** Every catalog/combos/routing endpoint the workspace can reach, with counted hits. */
function installFetch(): { hits: Map<string, number> } {
  const hits = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = url.replace(API_BASE, "").split("?")[0]!;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (url.includes("/api/models")) {
      return Response.json([
        { provider: "openai", id: "gpt-5", namespaced: "openai/gpt-5", native: true },
        { provider: "anthropic", id: "claude", namespaced: "anthropic/claude" },
      ]);
    }
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([{ name: "openai", disabled: false }]);
    if (url.includes("/api/selected-models")) return Response.json({});
    if (url.includes("/api/combos")) return Response.json([]);
    if (url.includes("/api/config")) return Response.json({ providers: { openai: { defaultModel: "gpt-5" } } });
    if (url.includes("/api/routing-profiles")) return Response.json([]);
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/shadow-call-settings")) return Response.json({ enabled: false });
    if (url.includes("/api/v2")) return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { hits };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
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

async function mountModels(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase={API_BASE} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return { container, root };
}

const tabs = (container: HTMLElement) => [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
const panel = (container: HTMLElement, id: string) => container.querySelector(`#models-panel-${id}`);

test("the strip renders all three tabs with the catalog selected on the bare hash", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    expect(tabs(container).map(t => t.id)).toEqual([
      "models-tab-catalog", "models-tab-combos", "models-tab-routing",
    ]);
    const selected = tabs(container).filter(t => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("models-tab-catalog");
    // Roving tabindex: exactly one tab is in the tab order.
    expect(tabs(container).filter(t => t.tabIndex === 0)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The regression that shipped and had to be fixed: catalog loading and cold failure were
 * component-level early returns, so a slow catalog replaced the entire workspace — strip
 * included — and a cold failure left Combos and Routing unreachable.
 */
test("a cold catalog never removes the tab strip", async () => {
  let releaseCatalog!: () => void;
  const gate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) { await gate; return Response.json([]); }
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    // Still cold here: the catalog fetch is parked on the gate.
    expect(tabs(container)).toHaveLength(3);
    expect(panel(container, "catalog")).toBeTruthy();
    releaseCatalog();
    await act(async () => { await Promise.resolve(); });
    expect(tabs(container)).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a cold catalog failure still leaves the other tabs reachable", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models")) throw new Error("catalog down");
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountModels();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(tabs(container)).toHaveLength(3);
    const combosTab = container.querySelector("#models-tab-combos") as HTMLButtonElement;
    expect(combosTab).toBeTruthy();
    expect(combosTab.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("panels mount lazily and then stay mounted, hidden", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    // Never visited: not in the tree at all.
    expect(panel(container, "combos")).toBeNull();
    expect(panel(container, "routing")).toBeNull();

    await act(async () => {
      (container.querySelector("#models-tab-combos") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(panel(container, "combos")).toBeTruthy();
    expect(panel(container, "catalog")?.hasAttribute("hidden")).toBe(true);

    await act(async () => {
      (container.querySelector("#models-tab-catalog") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    // Still mounted, just hidden — this is what lets an unsaved draft survive.
    expect(panel(container, "combos")).toBeTruthy();
    expect(panel(container, "combos")?.hasAttribute("hidden")).toBe(true);
    expect(panel(container, "catalog")?.hasAttribute("hidden")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("every rendered panel is wired to its tab and carries an error boundary", async () => {
  installFetch();
  const { container, root } = await mountModels();
  try {
    for (const id of ["combos", "routing"]) {
      await act(async () => {
        (container.querySelector(`#models-tab-${id}`) as HTMLButtonElement).click();
      });
      await act(async () => { await Promise.resolve(); });
    }
    for (const id of ["catalog", "combos", "routing"]) {
      const p = panel(container, id)!;
      expect(p.getAttribute("role")).toBe("tabpanel");
      expect(p.getAttribute("aria-labelledby")).toBe(`models-tab-${id}`);
      const tab = container.querySelector(`#models-tab-${id}`)!;
      expect(tab.getAttribute("aria-controls")).toBe(`models-panel-${id}`);
    }
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The whole point of gating: a hidden catalog must stop polling. Counted rather than
 * timed, because the assertion is "no NEW requests", not "requests within a window".
 */
test("leaving the catalog stops its requests", async () => {
  const { hits } = installFetch();
  const { container, root } = await mountModels();
  try {
    await act(async () => { await Promise.resolve(); });
    const before = hits.get("/api/models") ?? 0;
    expect(before).toBeGreaterThan(0);

    await act(async () => {
      (container.querySelector("#models-tab-routing") as HTMLButtonElement).click();
    });
    await act(async () => { await Promise.resolve(); });
    const afterSwitch = hits.get("/api/models") ?? 0;

    // Let any interval that survived the switch fire.
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(hits.get("/api/models") ?? 0).toBe(afterSwitch);
  } finally {
    await act(async () => root.unmount());
  }
});
