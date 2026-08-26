/**
 * Presets and the picker (devlog 060).
 *
 * Case 1 keeps the phase honest: presets that violate our own compatibility
 * rules would be worse than shipping none.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { LAYER_INVENTORY } from "../../src/codex/prompt-layers";
import { PRESETS } from "../src/components/codex-set/presets";
import { lintPromptLayer } from "../src/components/codex-set/prompt-lint";
import { en } from "../src/i18n/en";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

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

function dialog(): HTMLElement { return document.querySelector("dialog.modal-overlay") as HTMLElement; }

test("1. every shipped preset lints clean", () => {
  // The self-consistency check. A preset that tripped our own compatibility
  // rules would be worse than shipping none, and this is a bug in the preset
  // rather than in the linter.
  expect(PRESETS.length).toBeGreaterThan(0);
  for (const preset of PRESETS) {
    expect(lintPromptLayer(preset.body), preset.id).toEqual([]);
  }
});

test("2. every preset is small and names no tool, identity, or environment fact", () => {
  for (const preset of PRESETS) {
    expect(Buffer.byteLength(preset.body, "utf8"), preset.id).toBeLessThanOrEqual(2048);
    const body = preset.body.toLowerCase();
    // The three things that make a layer harness-specific, and therefore unsafe
    // to append to a prompt Codex assembled.
    for (const forbidden of ["you are ", "apply_patch", "bash tool", "read tool", "your cwd", "today's date"]) {
      expect(body.includes(forbidden), preset.id + " / " + forbidden).toBe(false);
    }
  }
});

test("3. every preset carries a provenance line that says adaptation, not copy", () => {
  for (const preset of PRESETS) {
    const provenance = en[preset.provenanceKey];
    expect(provenance, preset.id).toBeTruthy();
    // The licensing statement: no verbatim third-party prompt is shipped here.
    const claimsAdaptation = provenance.includes("Adapted from") || provenance.includes("Written for");
    expect(claimsAdaptation, preset.id + ": " + provenance).toBe(true);
    if (provenance.includes("Adapted from")) {
      expect(provenance, preset.id).toContain("not a copy");
    }
  }
});

test("3b. the picker lists every preset with its provenance", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  for (const preset of PRESETS) {
    const item = container.querySelector("[data-preset-id=\"" + preset.id + "\"]");
    expect(item, preset.id).not.toBeNull();
    expect(item!.textContent, preset.id).toContain(en[preset.nameKey]);
    expect(item!.textContent, preset.id).toContain(en[preset.provenanceKey]);
  }
  await act(async () => { root.unmount(); });
});

test("4+6. choosing a preset opens a pre-filled editor whose text is editable", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const concise = PRESETS.find(p => p.id === "concise")!;
  await act(async () => {
    (container.querySelector("[data-preset-id=\"concise\"]") as HTMLButtonElement).click();
  });
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  const title = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  expect(textarea.value).toBe(concise.body);
  expect(title.value).toBe(en[concise.nameKey]);
  // A starting point, not a locked artifact: the textarea is writable.
  expect(textarea.readOnly).toBe(false);
  expect(textarea.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("5. the result is an ordinary custom layer", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot() });
    return json(snapshot());
  });
  const { container, root } = await mount();
  await act(async () => {
    (container.querySelector("[data-preset-id=\"korean\"]") as HTMLButtonElement).click();
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  // Written through the same endpoint and shape as a hand-typed layer - no
  // separate preset concept survives the save.
  expect(put.url).toBe("/api/codex-prompt/custom");
  expect(put.body.layers[0].enabled).toBe(true);
  expect(put.body.layers[0].id).toMatch(/^[a-z0-9]{6}$/);
  expect(put.body.layers[0].body).toBe(PRESETS.find(p => p.id === "korean")!.body);
  await act(async () => { root.unmount(); });
});

test("7. the blank option still exists beside the presets", async () => {
  // The + flow did not become preset-only: an empty editor is still one click.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const items = [...container.querySelectorAll(".codex-set-preset__item")];
  expect(items.length).toBe(PRESETS.length + 1);
  await act(async () => { (items[0] as HTMLButtonElement).click(); });
  expect((dialog().querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  await act(async () => { root.unmount(); });
});
