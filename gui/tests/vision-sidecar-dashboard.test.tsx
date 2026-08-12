import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardSidecarPanels } from "../src/pages/dashboard-overview-sections";
import type { SidecarData, SidecarPatch } from "../src/pages/dashboard-shared";
import {
  mergeSidecarSetting,
  VISION_MAX_DESCRIPTIONS_DEFAULT,
  VISION_TIMEOUT_MS_DEFAULT,
} from "../src/pages/dashboard-shared";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;

type Dash = ReturnType<typeof useDashboardData>;

const initialSidecar: SidecarData = {
  webSearch: { model: "gpt-5.6-luna", streamRoutedModelOutput: false },
  vision: {
    model: "gpt-5.6-luna",
    backend: "openai",
    reasoning: "medium",
    enabled: true,
    maxDescriptionsPerTurn: 8,
    timeoutMs: 45_000,
  },
  visionModels: [
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna", backend: "openai", baseline: true },
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini", backend: "openai", baseline: true },
  ],
};

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

function harness(sidecar: SidecarData = initialSidecar) {
  const patches: SidecarPatch[] = [];
  let current = sidecar;
  const listeners: Array<() => void> = [];
  const saveSidecar = async (patch: SidecarPatch) => {
    patches.push(patch);
    current = {
      webSearch: mergeSidecarSetting(current.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(current.vision, patch.vision),
      ...(current.visionModels ? { visionModels: current.visionModels } : {}),
    };
    for (const listener of listeners) listener();
  };
  const d = {
    t: (key: keyof typeof en, vars?: Record<string, string | number>) => {
      let out = en[key];
      if (vars) {
        for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
      }
      return out;
    },
    settings: { codexAutoStart: true, port: 10100, hostname: "127.0.0.1" },
    settingsSaving: false,
    toggleCodexAutoStart: () => {},
    sidecar,
    sidecarSaving: false,
    sidecarModels: [{ value: "gpt-5.6-luna", label: "gpt-5.6-luna" }],
    visionModels: sidecar.visionModels ?? [],
    models: [
      { id: "gpt-5.6-luna", provider: "openai", namespaced: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-5.4-mini", provider: "openai", namespaced: "gpt-5.4-mini", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
    saveSidecar,
    shadowCall: { enabled: false, model: "" },
    shadowCallSaving: false,
    shadowCallHelpTriggerRef: { current: null },
    shadowCallHelpOpen: false,
    setShadowCallHelpOpen: () => {},
    saveShadowCall: async () => {},
  } as unknown as Dash;
  listeners.push(() => {
    d.sidecar = current;
  });
  return { d, patches, getSidecar: () => current };
}

async function mount(d: Dash) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    if (!root) root = createRoot(host);
    root.render(<LanguageProvider><DashboardSidecarPanels d={d} /></LanguageProvider>);
  });
}

function visionCard() {
  return [...host.querySelectorAll(".dash-sidecar-row-card")].find(card =>
    card.textContent?.includes(en["dash.visionSidecar"]),
  ) as HTMLElement;
}

test("Dashboard hydrates enabled, max descriptions, and timeout from the server", async () => {
  await mount(harness().d);
  const card = visionCard();
  const toggle = card.querySelector<HTMLButtonElement>("button.switch");
  const maxInput = card.querySelector<HTMLInputElement>('input[aria-label="' + en["dash.visionMaxDescriptions"] + '"]');
  const timeoutInput = card.querySelector<HTMLInputElement>('input[aria-label="' + en["dash.visionTimeout"] + '"]');
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  expect(maxInput?.value).toBe(String(VISION_MAX_DESCRIPTIONS_DEFAULT));
  expect(timeoutInput?.value).toBe(String(VISION_TIMEOUT_MS_DEFAULT));
});

test("disable then re-enable sends only enabled and keeps the other Vision fields", async () => {
  const { d, patches, getSidecar } = harness();
  await mount(d);
  const toggle = () => visionCard().querySelector<HTMLButtonElement>("button.switch")!;

  await act(async () => { toggle().click(); });
  expect(patches).toEqual([{ vision: { enabled: false } }]);
  expect(getSidecar().vision).toMatchObject({
    enabled: false,
    model: "gpt-5.6-luna",
    backend: "openai",
    reasoning: "medium",
    maxDescriptionsPerTurn: 8,
    timeoutMs: 45_000,
  });

  await act(async () => {
    d.sidecar = getSidecar();
    root!.render(<LanguageProvider><DashboardSidecarPanels d={d} /></LanguageProvider>);
  });
  await act(async () => { toggle().click(); });
  expect(patches[1]).toEqual({ vision: { enabled: true } });
  expect(getSidecar().vision).toMatchObject({
    enabled: true,
    model: "gpt-5.6-luna",
    backend: "openai",
    reasoning: "medium",
    maxDescriptionsPerTurn: 8,
    timeoutMs: 45_000,
  });
});

test("editing the limit or timeout saves only that field", async () => {
  const { d, patches } = harness();
  await mount(d);
  const card = visionCard();
  const maxDec = card.querySelector<HTMLButtonElement>(`button[aria-label="${en["dash.visionMaxDescriptionsDec"]}"]`)!;
  const timeoutInc = card.querySelector<HTMLButtonElement>(`button[aria-label="${en["dash.visionTimeoutInc"]}"]`)!;

  await act(async () => { maxDec.click(); });
  expect(patches).toEqual([{ vision: { maxDescriptionsPerTurn: 7 } }]);

  await act(async () => { timeoutInc.click(); });
  expect(patches[1]).toEqual({ vision: { timeoutMs: 46_000 } });
});

test("an unrelated web-search save does not include Vision fields", async () => {
  const { d, patches } = harness();
  await mount(d);
  const streamToggle = [...host.querySelectorAll("button.switch")].find(button =>
    button.getAttribute("aria-label") === en["dash.webSearchStream"],
  ) as HTMLButtonElement;
  await act(async () => { streamToggle.click(); });
  expect(patches).toEqual([{ webSearch: { streamRoutedModelOutput: true } }]);
});

function pickOption(label: string) {
  return [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent === label);
}

function assertVisionControlFieldsOmitted(patch: SidecarPatch) {
  expect(patch.vision).toBeDefined();
  expect(patch.vision).not.toHaveProperty("enabled");
  expect(patch.vision).not.toHaveProperty("maxDescriptionsPerTurn");
  expect(patch.vision).not.toHaveProperty("timeoutMs");
}

test("model and reasoning saves still omit enabled, limit, and timeout", async () => {
  const { d, patches } = harness();
  await mount(d);
  const card = visionCard();
  const modelTrigger = card.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${en["dash.sidecarModel"]}"]`)!;
  const reasoningTrigger = card.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${en["dash.visionSidecar"]} — ${en["dash.injectionEffortLabel"]}"]`,
  )!;

  await act(async () => { modelTrigger.click(); });
  const nextModel = pickOption("gpt-5.4-mini");
  expect(nextModel).toBeTruthy();
  await act(async () => { nextModel!.click(); });
  expect(patches).toHaveLength(1);
  expect(patches[0]).toEqual({
    vision: { model: "gpt-5.4-mini", backend: "openai", reasoning: "medium" },
  });
  assertVisionControlFieldsOmitted(patches[0]!);

  await act(async () => { reasoningTrigger.click(); });
  const nextReasoning = pickOption("high");
  expect(nextReasoning).toBeTruthy();
  await act(async () => { nextReasoning!.click(); });
  expect(patches).toHaveLength(2);
  expect(patches[1]).toEqual({ vision: { reasoning: "high" } });
  assertVisionControlFieldsOmitted(patches[1]!);
});
