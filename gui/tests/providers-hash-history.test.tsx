import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { Window } from "happy-dom";
import { normalizeHashPath, replaceHash, navigateHash } from "../src/hash-routing";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange } from "../src/app-routing";

/**
 * Hash routing contract after WP5 removed the Classic/Workspace split.
 *
 * The cases that survived from the dual-layout era are the ones that were never about
 * the preference: the generic helpers, history semantics, and passive normalization.
 * The legacy `#providers/workspace` deep link is kept as a REDIRECT case — it must land
 * on `#providers` without trapping Back.
 */

describe("hash helpers", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map((k) => [k, Reflect.get(globalThis, k)]));
    win = new Window({ url: "http://localhost/#providers" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const k of keys) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
  });

  test("normalizeHashPath strips the leading marker in both forms", () => {
    expect(normalizeHashPath("#providers")).toBe("providers");
    expect(normalizeHashPath("#/providers")).toBe("providers");
    expect(normalizeHashPath("providers")).toBe("providers");
  });

  test("replaceHash does not increase history length", () => {
    const before = win.history.length;
    replaceHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBe(before);
  });

  test("navigateHash creates a deliberate history entry", () => {
    const before = win.history.length;
    navigateHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });
});

describe("route resolution", () => {
  test("bare page hashes resolve without a rewrite", () => {
    for (const page of ["dashboard", "providers", "models", "logs", "usage"]) {
      expect(resolveAppHashChange(page).replaceTo).toBeNull();
    }
  });

  test("the legacy workspace deep link redirects to #providers", () => {
    // WP5: the dual-layout hash is no longer a route. It must normalise away rather
    // than persist, and replaceTo (not a push) keeps Back usable.
    expect(hashBelongsToPage("providers/workspace", "providers")).toBe(false);
    const action = resolveAppHashChange("providers/workspace");
    expect(action.page).toBe("providers");
    expect(action.replaceTo).toBe("providers");
  });

  test("registered sub-hashes survive; unknown ones are normalised away", () => {
    expect(resolveAppHashChange("logs/debug").replaceTo).toBeNull();
    expect(resolveAppHashChange("dashboard/models").replaceTo).toBeNull();
    expect(resolveAppHashChange("providers/nope").replaceTo).toBe("providers");
    expect(resolveAppHashChange("models/nope").replaceTo).toBe("models");
  });

  test("legacy #debug still maps onto the Logs tab", () => {
    const action = resolveAppHashChange("debug");
    expect(action.page).toBe("logs");
    expect(action.replaceTo).toBe("logs/debug");
  });

  test("an unknown page falls back to the dashboard", () => {
    expect(readPageFromHash("#nonsense")).toBe("dashboard");
  });
});

describe("stale layout-preference cleanup", () => {
  test("the route hook clears every key the removed preference wrote", async () => {
    const src = await Bun.file(new URL("../src/use-app-route-state.ts", import.meta.url)).text();

    // One-shot cleanup: there is a single layout now, so these would otherwise sit in
    // every user's storage forever.
    expect(src).toContain("clearStaleViewKeys");
    expect(src).toContain("localStorage.removeItem");
    for (const key of [
      "ocx-global-view",
      "ocx-view",
      "ocx-providers-view",
      "ocx-subagents-view",
      "ocx-storage-view",
      "ocx-codexauth-view",
      "ocx-apikeys-view",
      "ocx-claudecode-view",
      "ocx-usage-view",
      "ocx-logs-view",
      "ocx-models-view",
      "ocx-dashboard-view",
    ]) {
      expect(src).toContain(key);
    }
  });

  test("the layout toggle and its i18n keys are gone", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(app).not.toContain("toggleGlobalWorkspace");
    expect(app).not.toContain("viewMode");

    for (const locale of ["en", "ko", "ja", "de", "ru", "zh"]) {
      const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
      expect(src).not.toContain("pws.classicToggle");
      expect(src).not.toContain("pws.workspaceToggle");
      expect(src).not.toContain("app.viewMode");
    }
  });
});
