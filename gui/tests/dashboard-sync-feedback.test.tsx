import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardMaintenancePanel } from "../src/pages/dashboard-overview-sections";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT", "setTimeout", "clearTimeout"] as const;
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
    clearSyncFeedback: () => {},
    ...overrides,
  } as unknown as Dash;
}

async function mount(d: Dash) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    if (!root) root = createRoot(host);
    // The stale app-server hint renders <Trans>, which needs the provider context.
    root.render(<LanguageProvider><DashboardMaintenancePanel d={d} /></LanguageProvider>);
  });
}

// Controlled global timers: the toast hold timer runs through the real global setTimeout
// (the component calls it bare), so tests can advance time deterministically instead of
// waiting 6-8 real seconds. clearTimeout is a no-op here — stale timers are filtered out
// by the hold duration when fired.
let scheduledTimers: Array<{ fn: () => void; ms: number }> = [];
function installFakeTimers() {
  scheduledTimers = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    scheduledTimers.push({ fn, ms: ms ?? 0 });
    return scheduledTimers.length;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
}
async function fireTimers(ms: number) {
  const due = scheduledTimers.filter(t => t.ms === ms);
  scheduledTimers = scheduledTimers.filter(t => t.ms !== ms);
  await act(async () => { for (const t of due) t.fn(); });
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

test("success toast auto-dismisses after 6s; error toast holds for 8s", async () => {
  installFakeTimers();

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
  expect(host.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(6000);
  expect(host.querySelector(".action-toast")).toBeNull();

  // Fresh mount so the success dismissal state cannot suppress the error toast.
  await act(async () => { root?.unmount(); root = null; });
  // Error tone: still visible at the 6s success boundary, dismissed only at 8s.
  await mount(dash({ syncError: "boom" }));
  expect(host.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(6000);
  expect(host.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(8000);
  expect(host.querySelector(".action-toast")).toBeNull();
});

test("warning-bearing results never auto-dismiss and offer an explicit dismiss", async () => {
  installFakeTimers();

  await mount(dash({
    syncResult: {
      ok: true,
      added: 3,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: true,
      message: "ok",
      nativeSubagentDefaultsWarning: "native defaults were not applied",
      staleAppServerHint: "restart codex",
    },
  }));

  const toast = host.querySelector<HTMLElement>(".action-toast");
  expect(toast).not.toBeNull();
  expect(toast!.className).toContain("notice-warn");
  // The stale-app-server hint and warning stay in the message.
  expect(toast!.textContent).toContain("ocx sync --restart-codex");
  // Still visible well past the plain success 6s / error 8s hold times.
  await fireTimers(6000);
  await fireTimers(8000);
  expect(host.querySelector(".action-toast")).not.toBeNull();

  // The dismiss button closes it and calls clearSyncFeedback (the parent-level clear).
  const dismiss = toast!.querySelector<HTMLButtonElement>(".action-toast-dismiss");
  expect(dismiss).not.toBeNull();
  await act(async () => { dismiss!.click(); });
  expect(host.querySelector(".action-toast")).toBeNull();
});

test("dismissing the sync toast clears the dashboard-level result, not just a local flag", async () => {
  installFakeTimers();

  const cleared: string[] = [];
  await mount(dash({
    syncError: "boom",
    clearSyncFeedback: () => { cleared.push("cleared"); },
  }));
  const dismiss = host.querySelector<HTMLButtonElement>(".action-toast-dismiss");
  expect(dismiss).not.toBeNull();
  await act(async () => { dismiss!.click(); });
  expect(cleared).toEqual(["cleared"]);
  expect(host.querySelector(".action-toast")).toBeNull();
});

test("a timer-dismissed result does not remount as a fresh toast after the panel unmounts", async () => {
  installFakeTimers();

  // Models the real data flow: syncResult lives in useDashboardData above the dashboard
  // tabs, and clearSyncFeedback clears it there. A component-local dismissed flag alone
  // would reset on unmount and resurrect the stale toast when the tab is revisited.
  const state: { result: NonNullable<Dash["syncResult"]> | null; error: string | null } = {
    result: {
      ok: true,
      added: 3,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: true,
      message: "ok",
    },
    error: null,
  };
  const makeDash = () => dash({
    syncResult: state.result,
    syncError: state.error,
    clearSyncFeedback: () => {
      state.result = null;
      state.error = null;
    },
  });

  await mount(makeDash());
  expect(host.querySelector(".action-toast")).not.toBeNull();

  // Auto-dismiss fires the timer, which clears the dashboard-level result.
  await fireTimers(6000);
  expect(host.querySelector(".action-toast")).toBeNull();
  expect(state.result).toBeNull();

  // Tab switch unmounts the panel; remounting reads the (now cleared) parent state, so
  // the stale result cannot reappear as a fresh toast.
  await act(async () => { root?.unmount(); root = null; });
  await mount(makeDash());
  expect(host.querySelector(".action-toast")).toBeNull();
});

test("a new sync re-arms a dismissed toast", async () => {
  installFakeTimers();

  let d: Dash = dash({ syncResult: null });
  await mount(d);
  expect(host.querySelector(".action-toast")).toBeNull();

  // First sync result: toast appears, then auto-dismisses.
  d = dash({
    syncResult: {
      ok: true,
      added: 3,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: true,
      message: "ok",
    },
  });
  await mount(d);
  expect(host.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(6000);
  expect(host.querySelector(".action-toast")).toBeNull();

  // A fresh sync click (re-arms dismissed=false) with a new result re-shows the
  // toast on a fresh 6s timer instead of staying hidden.
  const syncButton = [...host.querySelectorAll<HTMLButtonElement>(".maintenance-actions button")]
    .find(b => !b.classList.contains("maintenance-update-anchor"))!;
  await act(async () => { syncButton.click(); });
  d = dash({
    syncResult: {
      ok: true,
      added: 5,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: true,
      message: "ok",
    },
  });
  await mount(d);
  expect(host.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(6000);
  expect(host.querySelector(".action-toast")).toBeNull();
});
