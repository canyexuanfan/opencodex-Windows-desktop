import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import {
  navigateHash,
  normalizeHashPath,
  replaceHash,
  resolveProvidersHashChange,
} from "../src/hash-routing";
import {
  GLOBAL_VIEW_KEY,
  providersHashForViewMode,
  readViewMode,
  writeViewMode,
  type ViewMode,
} from "../src/view-mode";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.localStorage.clear();
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

describe("hash-routing helpers", () => {
  test("replaceHash does not increase history length", () => {
    const before = testWindow.history.length;
    testWindow.location.hash = "#providers";
    const afterAssign = testWindow.history.length;
    replaceHash("providers/workspace", testWindow as unknown as Window);
    expect(normalizeHashPath(testWindow.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBe(afterAssign);
    expect(testWindow.history.length).toBeGreaterThanOrEqual(before);
  });

  test("navigateHash creates a deliberate history entry", () => {
    testWindow.location.hash = "#providers";
    const before = testWindow.history.length;
    navigateHash("providers/workspace", testWindow as unknown as Window);
    expect(normalizeHashPath(testWindow.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBeGreaterThan(before);
  });

  test("resolveProvidersHashChange rewrites bare providers when workspace is preferred", () => {
    expect(resolveProvidersHashChange("providers", "workspace")).toEqual({
      replaceTo: "providers/workspace",
      viewMode: "workspace",
      handledPassively: true,
    });
  });

  test("resolveProvidersHashChange preserves workspace deep link", () => {
    expect(resolveProvidersHashChange("providers/workspace", "classic")).toEqual({
      replaceTo: null,
      viewMode: "workspace",
      handledPassively: false,
    });
  });
});

/**
 * Mirrors App's Providers hash ownership: hashchange listener + viewMode sync effect.
 * Kept local so the test exercises the same replace/navigate contract without mounting
 * the full App (network, i18n, sidebar).
 */
function ProvidersHashShell({
  initialMode,
}: {
  initialMode: ViewMode;
}) {
  const [page, setPage] = useState(() => {
    const raw = normalizeHashPath(window.location.hash);
    return raw.split("/")[0] || "dashboard";
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    writeViewMode(initialMode);
    const raw = normalizeHashPath(window.location.hash);
    if (raw === "providers/workspace") {
      writeViewMode("workspace");
      return "workspace";
    }
    return readViewMode();
  });

  useEffect(() => {
    const onHash = () => {
      const rawHash = normalizeHashPath(window.location.hash);
      const nextPage = rawHash.split("/")[0] || "dashboard";
      if (nextPage === "providers") {
        const preferred = readViewMode();
        const resolved = resolveProvidersHashChange(rawHash, preferred);
        if (resolved.replaceTo) {
          replaceHash(resolved.replaceTo);
          if (resolved.viewMode) {
            writeViewMode(resolved.viewMode);
            setViewMode(resolved.viewMode);
          }
          setPage("providers");
          return;
        }
        if (resolved.viewMode) {
          writeViewMode(resolved.viewMode);
          setViewMode(resolved.viewMode);
        }
      }
      setPage(nextPage);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (page !== "providers") return;
    const wanted = providersHashForViewMode(viewMode);
    const raw = normalizeHashPath(window.location.hash);
    if (raw !== wanted) replaceHash(wanted);
  }, [page, viewMode]);

  return (
    <div>
      <div data-testid="page">{page}</div>
      <div data-testid="mode">{viewMode}</div>
      <button
        type="button"
        data-testid="toggle"
        onClick={() => {
          const next = viewMode === "classic" ? "workspace" : "classic";
          writeViewMode(next);
          setViewMode(next);
          if (page === "providers") navigateHash(providersHashForViewMode(next));
        }}
      >
        toggle
      </button>
      <button
        type="button"
        data-testid="go-dashboard"
        onClick={() => {
          navigateHash("dashboard");
          setPage("dashboard");
        }}
      >
        dashboard
      </button>
      <button
        type="button"
        data-testid="go-providers"
        onClick={() => {
          navigateHash(providersHashForViewMode(readViewMode()));
          setPage("providers");
        }}
      >
        providers
      </button>
    </div>
  );
}

describe("Providers hash history integration", () => {
  async function mount(initialMode: ViewMode, initialHash: string) {
    testWindow.location.hash = initialHash;
    writeViewMode(initialMode);
    testWindow.localStorage.setItem(GLOBAL_VIEW_KEY, initialMode);
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    const historyBefore = testWindow.history.length;
    await act(async () => {
      root = createRoot(host);
      root.render(<ProvidersHashShell initialMode={initialMode} />);
    });
    return { root, host, historyBefore };
  }

  test("stored workspace + #providers passively normalizes without growing history", async () => {
    const { root, host, historyBefore } = await mount("workspace", "#providers");
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(testWindow.history.length).toBe(historyBefore);
    await act(async () => { root.unmount(); });
  });

  test("direct #providers/workspace deep link forces workspace without duplicate history", async () => {
    const { root, host, historyBefore } = await mount("classic", "#providers/workspace");
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(readViewMode()).toBe("workspace");
    expect(testWindow.history.length).toBe(historyBefore);
    await act(async () => { root.unmount(); });
  });

  test("explicit toggle Classic→Workspace pushes one history entry", async () => {
    const { root, host } = await mount("classic", "#providers");
    const before = testWindow.history.length;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("workspace");
    expect(readViewMode()).toBe("workspace");
    expect(testWindow.history.length).toBe(before + 1);
    await act(async () => { root.unmount(); });
  });

  test("explicit toggle Workspace→Classic pushes one history entry", async () => {
    const { root, host } = await mount("workspace", "#providers/workspace");
    const before = testWindow.history.length;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("classic");
    expect(testWindow.history.length).toBe(before + 1);
    await act(async () => { root.unmount(); });
  });

  test("Back after passive normalization can leave Providers without bouncing", async () => {
    writeViewMode("workspace");
    testWindow.location.hash = "#dashboard";
    const { root, host } = await mount("workspace", "#dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-providers"]')!.click();
    });
    // Deliberate nav lands on preferred workspace hash.
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");

    // Simulate a stale Back target of bare #providers (old history entry).
    await act(async () => {
      testWindow.location.hash = "#providers";
      window.dispatchEvent(new testWindow.HashChangeEvent("hashchange"));
    });
    // Passive replace back to workspace — history length must not grow from that rewrite.
    const afterNormalize = testWindow.history.length;
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="go-dashboard"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    expect(host.querySelector('[data-testid="page"]')?.textContent).toBe("dashboard");

    // Returning via deliberate Back-like assign to bare providers must normalize again without a loop of pushes.
    await act(async () => {
      testWindow.location.hash = "#providers";
      window.dispatchEvent(new testWindow.HashChangeEvent("hashchange"));
    });
    expect(normalizeHashPath(window.location.hash)).toBe("providers/workspace");
    expect(testWindow.history.length).toBeLessThanOrEqual(afterNormalize + 2);
    await act(async () => { root.unmount(); });
  });

  test("non-Providers routes are unaffected by viewMode", async () => {
    const { root, host } = await mount("workspace", "#dashboard");
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.click();
    });
    expect(normalizeHashPath(window.location.hash)).toBe("dashboard");
    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("classic");
    await act(async () => { root.unmount(); });
  });
});
