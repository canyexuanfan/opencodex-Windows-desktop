import { describe, expect, test } from "bun:test";
import { getDesktopLifecycleApi } from "../src/desktop-lifecycle";

describe("desktop lifecycle bridge", () => {
  test("is absent in the normal browser runtime", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    expect(getDesktopLifecycleApi()).toBeNull();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as Record<string, unknown>).window;
  });

  test("returns only the preload-owned lifecycle bridge when present", () => {
    const bridge = {
      getStatus: async () => ({}),
      startProxy: async () => ({}),
      stopProxy: async () => ({}),
      restartProxy: async () => ({}),
      requestExit: async () => ({}),
    };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { openCodexDesktop: bridge } });
    expect(getDesktopLifecycleApi()).toBe(bridge);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as Record<string, unknown>).window;
  });
});
