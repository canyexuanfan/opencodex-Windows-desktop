/**
 * The layer stack: assembly order made visible, and transition notices kept
 * apart from state layers (devlog 023).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { LAYER_INVENTORY } from "../../src/codex/prompt-layers";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

/** Verified transition-only in devlog 023: realtime.rs:43-53 and model.rs:44-60. */
const TRANSITION_IDS = ["realtime", "model-switch"];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: true,
    developerInstructionsState: "owned" as const,
    drift: null,
    revision: "sha256:one",
    inventory: INVENTORY,
    toggles: INVENTORY.filter(d => d.class === "config-toggle").map(d => ({
      id: d.id, key: d.key as string, userFileValue: null, defaultedUserValue: true, default: true,
    })),
    extensionLayersEnumerable: false,
    custom: [],
    modelInstructionsFile: null,
    ...over,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#codex-set/prompt" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

interface Call { url: string; method: string; body: any }
function stubRoutes(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><CodexSetPrompt apiBase="" /></LanguageProvider>);
  });
  return { root, container };
}

test("1. a built-in row shows its CANONICAL assembly index, not a renumbering", async () => {
  // Renumbering per visual group would invent an order the runtime does not
  // have. The gaps left by the lifted transition notices are the proof.
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  for (const d of INVENTORY) {
    if (d.class === "extension-unknown") continue;
    const row = container.querySelector("[data-layer-id=\"" + d.id + "\"]");
    expect(row, d.id).not.toBeNull();
    const shown = row!.querySelector(".codex-set-prompt__pos")!.textContent;
    expect(shown, d.id).toBe(d.order === null ? "\u00b7" : String(d.order + 1));
  }
  await act(async () => { root.unmount(); });
});

test("2+3. the transition group holds exactly the two notices, and nothing is dropped", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  const lists = [...container.querySelectorAll(".codex-set-prompt__rows")];
  expect(lists.length).toBeGreaterThanOrEqual(2);
  const idsIn = (list: Element) => [...list.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  const transition = idsIn(lists[1]!);
  expect(transition.sort()).toEqual([...TRANSITION_IDS].sort());

  // Exactly once across the two groups: a split that loses a layer is worse
  // than no split at all.
  const all = [...container.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  const expected = INVENTORY.filter(d => d.class !== "extension-unknown").map(d => d.id);
  expect(all.slice().sort()).toEqual(expected.slice().sort());
  expect(new Set(all).size).toBe(all.length);
  await act(async () => { root.unmount(); });
});

test("a transition notice is never labelled always-on", async () => {
  // It is not on, it fires. Reusing the locked label would claim this text is
  // in every prompt when it appears only at a change.
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot())));
  const { container, root } = await mount();
  for (const id of TRANSITION_IDS) {
    const note = container.querySelector("[data-layer-id=\"" + id + "\"] .codex-set-prompt__note");
    expect(note, id).not.toBeNull();
    expect(note!.textContent, id).not.toContain("Always on");
  }
  // A genuinely locked layer keeps the strong label.
  expect(container.querySelector("[data-layer-id=\"base-instructions\"] .codex-set-prompt__note")!.textContent)
    .toContain("Always on");
  await act(async () => { root.unmount(); });
});

function layer(over: Record<string, unknown> = {}) {
  return { id: "aaaaaa", title: "First", body: "Alpha.", enabled: true, ...over };
}

const THREE = [layer(), layer({ id: "bbbbbb", title: "Second", body: "Beta." }), layer({ id: "cccccc", title: "Third", body: "Gamma." })];

function dialog(): HTMLElement { return document.querySelector("dialog.modal-overlay") as HTMLElement; }
function navButtons() { return [...dialog().querySelectorAll(".codex-set-custom-dialog__nav button")] as HTMLButtonElement[]; }
function navPos() { return dialog().querySelector(".codex-set-custom-dialog__nav-pos")?.textContent ?? ""; }
function fields() {
  return {
    title: dialog().querySelector("input[type=\"text\"]") as HTMLInputElement,
    body: dialog().querySelector("textarea") as HTMLTextAreaElement,
  };
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof testWindow.HTMLTextAreaElement
    ? testWindow.HTMLTextAreaElement.prototype
    : testWindow.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  el.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

async function openEditor(container: HTMLElement, id: string): Promise<void> {
  await act(async () => {
    (container.querySelector("[data-custom-id=\"" + id + "\"] button") as HTMLButtonElement).click();
  });
}

test("5+6. next and prev move the editor target, show the position, and write nothing", async () => {
  const calls = stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(navPos()).toBe("1 / 3");
  expect(fields().title.value).toBe("First");

  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("2 / 3");
  // Title AND body follow the layer, not just the label.
  expect(fields().title.value).toBe("Second");
  expect(fields().body.value).toBe("Beta.");

  await act(async () => { navButtons()[0]!.click(); });
  expect(navPos()).toBe("1 / 3");
  expect(fields().title.value).toBe("First");

  // Navigating is not saving.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("7. the ends are disabled rather than wrapping", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(navButtons()[0]!.disabled).toBe(true);
  // Clicking a disabled end leaves the editor exactly where it was.
  await act(async () => { navButtons()[0]!.click(); });
  expect(navPos()).toBe("1 / 3");

  await act(async () => { navButtons()[1]!.click(); });
  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("3 / 3");
  expect(navButtons()[1]!.disabled).toBe(true);
  await act(async () => { navButtons()[1]!.click(); });
  expect(navPos()).toBe("3 / 3");
  await act(async () => { root.unmount(); });
});

test("8. an unsaved edit survives navigating away and back", async () => {
  // The case that matters. Blocking navigation while dirty would pass a weaker
  // version of this while making the feature pointless: comparing two layers
  // mid-edit is the whole reason to move between them.
  const calls = stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: THREE }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  await act(async () => {
    typeInto(fields().title, "Edited first");
    typeInto(fields().body, "Work in progress.");
  });

  await act(async () => { navButtons()[1]!.click(); });
  expect(fields().title.value).toBe("Second");

  await act(async () => { navButtons()[0]!.click(); });
  expect(fields().title.value).toBe("Edited first");
  expect(fields().body.value).toBe("Work in progress.");
  // And nothing was written along the way.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("10. one layer offers no navigation at all", async () => {
  stubRoutes(call => (call.url.includes("/text") ? json({ ok: true, layers: {} }) : json(snapshot({ custom: [layer()] }))));
  const { container, root } = await mount();
  await openEditor(container, "aaaaaa");
  expect(dialog().querySelector(".codex-set-custom-dialog__nav")).toBeNull();
  await act(async () => { root.unmount(); });
});
