import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { DashboardMaintenancePanel } from "../src/pages/dashboard-overview-sections";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;

type Dash = ReturnType<typeof useDashboardData>;

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
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
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

function dash(overrides: Partial<Dash> = {}): Dash {
  return {
    t: (key: keyof typeof en) => en[key],
    runSync: async () => {},
    syncing: false,
    updateTriggerRef: { current: null },
    openUpdateDialog: () => {},
    updateLoading: false,
    updateOpen: false,
    syncResult: null,
    syncError: null,
    updateJob: null,
    reconnecting: false,
    ...overrides,
  } as unknown as Dash;
}

async function mount(d: Dash) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<DashboardMaintenancePanel d={d} />);
  });
}

test("renders sync feedback as a fixed toast, not an inline notice under the row", async () => {
  await mount(dash({
    syncResult: {
      ok: true,
      added: 3,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: true,
      message: "ok",
    },
  }));

  const toast = host.querySelector<HTMLElement>(".action-toast");
  expect(toast).not.toBeNull();
  expect(toast!.className).toContain("notice-ok");
  expect(toast!.getAttribute("role")).toBe("status");
  expect(toast!.textContent).toContain("Sync complete");
  // The toast lives outside the panel so it cannot push the panel's content around.
  expect(host.querySelector(".maintenance-panel .sync-toast")).toBeNull();
  // The old inline notice below the row is gone.
  expect(host.querySelector(".maintenance-notice")).toBeNull();
  // The row itself is still there.
  expect(host.querySelector(".dash-sync-summary")).not.toBeNull();
});

test("renders sync errors as an error-toned toast", async () => {
  await mount(dash({ syncError: "boom" }));

  const toast = host.querySelector<HTMLElement>(".action-toast");
  expect(toast).not.toBeNull();
  expect(toast!.className).toContain("notice-err");
  expect(toast!.textContent).toContain("Sync failed");
  expect(host.querySelector(".maintenance-notice")).toBeNull();
});
