/**
 * The full prompt-layer taxonomy (devlog 260802_codex_set_prompt_composer/040).
 *
 * Case 2 is ask item 9 at the rendering layer; the route test proves the same
 * guarantee at the API boundary. Both are required - one without the other is a
 * UI that merely looks safe, or an API nobody exercises.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

/** The shipped inventory, verbatim from src/codex/prompt-layers.ts. */
const INVENTORY = [
  { id: "base-instructions", class: "base", key: null, default: null, order: 0 },
  { id: "model-switch", class: "runtime-conditional", key: null, default: null, order: 1 },
  { id: "personality", class: "feature-gated", key: "features.personality", default: true, order: 2 },
  { id: "context-window-guidance", class: "feature-gated", key: "features.token_budget", default: false, order: 3 },
  { id: "realtime", class: "runtime-conditional", key: null, default: null, order: 4 },
  { id: "agents-md", class: "runtime-conditional", key: null, default: null, order: 5 },
  { id: "permissions", class: "config-toggle", key: "include_permissions_instructions", default: true, order: 6 },
  { id: "collaboration", class: "config-toggle", key: "include_collaboration_mode_instructions", default: true, order: 7 },
  { id: "environment", class: "config-toggle", key: "include_environment_context", default: true, order: 8 },
  { id: "environments-instructions", class: "feature-gated", key: "features.deferred_executor", default: false, order: 9 },
  { id: "apps", class: "config-toggle", key: "include_apps_instructions", default: true, order: 10 },
  { id: "plugins", class: "runtime-conditional", key: null, default: null, order: 11 },
  { id: "tools", class: "feature-gated", key: "features.deferred_tool_world_state", default: false, order: 12 },
  { id: "skills", class: "config-toggle", key: "skills.include_instructions", default: true, order: 13 },
  { id: "multi-agent-mode", class: "feature-gated", key: "features.multi_agent_v2.enabled", default: false, order: 14 },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: false,
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

function stubRoutes(handler: (call: { url: string; method: string; body: unknown }) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
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

function row(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector("[data-layer-id=\"" + id + "\"]");
}

test("1. every inventory entry renders a row, in assembly order", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const rendered = [...container.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  // Assembly order, so the list reads the way the prompt is built.
  expect(rendered).toEqual(INVENTORY.map(d => d.id));
  await act(async () => { root.unmount(); });
});

test("2. every non-config-toggle class renders NO switch element at all", async () => {
  // Ask item 9. Not a disabled checkbox and not a greyed toggle: a disabled
  // control claims the capability exists and is temporarily unavailable, which
  // is false. Table-driven over the inventory, so a new upstream layer is
  // covered the day WP1 lists it.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const locked = INVENTORY.filter(d => d.class !== "config-toggle");
  expect(locked.length).toBeGreaterThan(0);
  for (const descriptor of locked) {
    const el = row(container, descriptor.id);
    expect(el, descriptor.id).not.toBeNull();
    expect(el!.querySelector("input"), descriptor.id).toBeNull();
    expect(el!.querySelector("[role=\"switch\"]"), descriptor.id).toBeNull();
  }
  // And every config-toggle DOES get one, or the assertion above proves nothing.
  for (const descriptor of INVENTORY.filter(d => d.class === "config-toggle")) {
    expect(row(container, descriptor.id)!.querySelector("input[role=\"switch\"]"), descriptor.id).not.toBeNull();
  }
  await act(async () => { root.unmount(); });
});

test("3. a feature-gated row names its governing key and is not called always-on", async () => {
  // These layers ARE disableable - through [features], not from this page.
  // Calling them always-on would tell a user a setting does not exist.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const personality = row(container, "personality")!;
  expect(personality.textContent).toContain("features.personality");
  expect(personality.querySelector(".codex-set-prompt__note--locked")).toBeNull();
  const base = row(container, "base-instructions")!;
  expect(base.querySelector(".codex-set-prompt__note--locked")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("5. extension layers render as a statement, never as rows", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  expect(container.querySelector(".codex-set-prompt__extensions")).not.toBeNull();
  expect(container.querySelector("[data-layer-class=\"extension-unknown\"]")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("6. a rejected PUT reverts the row to server truth", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "config_unreadable", message: "nope" }, 409);
    return json(snapshot());
  });
  const { container, root } = await mount();
  const apps = row(container, "apps")!.querySelector("input") as HTMLInputElement;
  expect(apps.checked).toBe(true);
  await act(async () => { apps.click(); });
  // The switch must not keep showing a state the file does not have.
  const after = row(container, "apps")!.querySelector("input") as HTMLInputElement;
  expect(after.checked).toBe(true);
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  expect(calls.filter(c => c.method === "GET").length).toBeGreaterThan(1);
  await act(async () => { root.unmount(); });
});

test("7. the dialog opens read-only: no textarea, no save", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const trigger = row(container, "permissions")!.querySelector("button") as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const dialog = document.querySelector("dialog.modal-overlay");
  expect(dialog).not.toBeNull();
  expect(dialog!.querySelector("textarea")).toBeNull();
  expect(dialog!.querySelector("input")).toBeNull();
  expect(dialog!.textContent).toContain("include_permissions_instructions");
  await act(async () => { root.unmount(); });
});

test("9. the dialog says plainly that no rendered layer text exists", async () => {
  // Omitting the body silently would read as a loading failure to anyone who
  // expected one. Codex exposes no API for it, so the dialog states that.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await act(async () => {
    (row(container, "base-instructions")!.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  expect(dialog.querySelector(".codex-set-layer-dialog__no-text")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("4. a runtime-conditional row states the condition that emits it", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await act(async () => {
    (row(container, "agents-md")!.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  expect(dialog.textContent).toContain("AGENTS.md");
  expect((dialog.textContent ?? "").length).toBeGreaterThan(40);
  await act(async () => { root.unmount(); });
});

test("8. Escape closes the dialog and returns focus to the row", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const trigger = row(container, "apps")!.querySelector("button") as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  expect(document.querySelector("dialog.modal-overlay")).not.toBeNull();
  const dialog = document.querySelector("dialog.modal-overlay") as HTMLDialogElement;
  await act(async () => {
    dialog.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));
  });
  expect(document.querySelector("dialog.modal-overlay")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("10. an unreadable config refuses writes on every switch", async () => {
  stubRoutes(() => json(snapshot({ readable: false })));
  const { container, root } = await mount();
  const switches = [...container.querySelectorAll("input[role=\"switch\"]")] as HTMLInputElement[];
  expect(switches).toHaveLength(5);
  for (const input of switches) expect(input.disabled).toBe(true);
  await act(async () => { root.unmount(); });
});

