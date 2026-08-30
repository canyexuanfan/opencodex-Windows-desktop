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
    baseVariants: [],
    baseSelection: { kind: "default" as const },
    maxBaseVariants: 2,
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

/**
 * The request body, typed rather than `any`.
 *
 * Every assertion below reads `body.layers[].id`, so `any` bought nothing and
 * cost the repository's lint gate. `revision` is optional because only the
 * write calls carry one.
 */
interface CallBody { layers?: { id: string; title: string; body: string }[]; revision?: string; enabled?: boolean }
interface Call { url: string; method: string; body: CallBody }
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

/** The picker is collapsed until its trigger is pressed. */
async function openPicker(container: HTMLElement): Promise<void> {
  await act(async () => {
    (container.querySelector(".codex-set-custom__add") as HTMLButtonElement).click();
  });
}

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

test("3. every preset states a source and says it is not a copy, in every locale", async () => {
  // This is a licensing statement, so an untranslated or softened rendering is a
  // real defect rather than a copy nit. English-only checking left eight locales
  // unprotected.
  const locales = await Promise.all([
    import("../src/i18n/en"), import("../src/i18n/ko"), import("../src/i18n/ja"),
    import("../src/i18n/zh"), import("../src/i18n/zh-TW"), import("../src/i18n/ru"),
    import("../src/i18n/de"), import("../src/i18n/fr"), import("../src/i18n/tr"),
  ]);
  const dicts = locales.map(m => Object.values(m)[0] as Record<string, string>);
  expect(dicts).toHaveLength(9);

  for (const preset of PRESETS) {
    for (const dict of dicts) {
      const provenance = dict[preset.provenanceKey];
      expect(provenance, preset.id).toBeTruthy();
      // Long enough to be a sentence rather than a label: every one of these names
      // a source AND disclaims copying, which does not fit in three words.
      expect(provenance!.length, preset.id).toBeGreaterThan(20);
    }
    // The English text is the one we can assert semantically.
    const english = en[preset.provenanceKey];
    expect(english, preset.id).toMatch(/Adapted from|Written for/);
    expect(english, preset.id).toContain("not a copy");
  }
});

test("3b. the picker lists every preset with its provenance", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await openPicker(container);
  for (const preset of PRESETS) {
    const item = container.querySelector("[data-preset-id=\"" + preset.id + "\"]");
    expect(item, preset.id).not.toBeNull();
    expect(item!.textContent, preset.id).toContain(en[preset.nameKey]);
    expect(item!.textContent, preset.id).toContain(en[preset.provenanceKey]);
  }
  await act(async () => { root.unmount(); });
});

test("4+6. a preset pre-fills the editor, and the EDITED text is what saves", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot() });
    return json(snapshot());
  });
  const { container, root } = await mount();
  const concise = PRESETS.find(p => p.id === "concise")!;
  await openPicker(container);
  await act(async () => {
    (container.querySelector("[data-preset-id=\"concise\"]") as HTMLButtonElement).click();
  });
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  const title = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  expect(textarea.value).toBe(concise.body);
  expect(title.value).toBe(en[concise.nameKey]);

  // A starting point, not a locked artifact. Checking the DOM flags proves the
  // control accepts input; typing and saving proves the EDIT is what ships.
  const edited = concise.body + "\nAlso: never apologize for brevity.";
  await act(async () => {
    const proto = testWindow.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(textarea, edited);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  expect(calls.find(c => c.method === "PUT")!.body.layers[0].body).toBe(edited);
  await act(async () => { root.unmount(); });
});

test("5. the result is an ordinary custom layer", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot() });
    return json(snapshot());
  });
  const { container, root } = await mount();
  await openPicker(container);
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
  await openPicker(container);
  const items = [...container.querySelectorAll(".codex-set-preset__item")];
  expect(items.length).toBe(PRESETS.length + 1);
  await act(async () => { (items[0] as HTMLButtonElement).click(); });
  expect((dialog().querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  await act(async () => { root.unmount(); });
});

test("7b. with no presets the submenu disappears and + is a single action", async () => {
  // 060: an empty menu is worse than no menu, which is why WP5 shipped + without
  // one. If the preset list is ever emptied, the affordance must collapse back.
  // The list is injected rather than module-mocked: a mock would leak into every
  // later case in the file, which is exactly what happened first time round.
  const { default: PresetPicker } = await import("../src/components/codex-set/PresetPicker");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  let blanks = 0;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <PresetPicker disabled={false} presets={[]} onBlank={() => { blanks += 1; }} onPreset={() => {}} />
      </LanguageProvider>,
    );
  });

  const trigger = container.querySelector(".codex-set-custom__add") as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  await act(async () => { trigger.click(); });
  // No menu at all, and the click went straight to the blank editor.
  expect(container.querySelector(".codex-set-preset__menu")).toBeNull();
  expect(container.querySelector(".codex-set-preset__item")).toBeNull();
  expect(blanks).toBe(1);
  await act(async () => { root.unmount(); });
});
test("a disabled picker cannot be opened at all, not merely announced as disabled", async () => {
  // aria-disabled on a <summary> announced a disabled control while still opening
  // on click and on Enter, so WP5's disabled-Add contract was true only to a
  // screen reader.
  stubRoutes(() => json(snapshot({ readable: false })));
  const { container, root } = await mount();
  const trigger = container.querySelector(".codex-set-custom__add") as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  await act(async () => { trigger.click(); });
  expect(container.querySelector(".codex-set-preset__menu")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("the picker closes when a preset is chosen", async () => {
  // The editor opens over this. A menu left expanded behind a modal is still there
  // when the modal closes.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await openPicker(container);
  expect(container.querySelector(".codex-set-preset__menu")).not.toBeNull();
  await act(async () => {
    (container.querySelector("[data-preset-id=\"korean\"]") as HTMLButtonElement).click();
  });
  expect(container.querySelector(".codex-set-preset__menu")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("a seeded editor is not dirty until the user changes something", async () => {
  // The dirty check compared against empty strings, so a preset-seeded editor asked
  // to discard changes nobody had made.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await openPicker(container);
  await act(async () => {
    (container.querySelector("[data-preset-id=\"concise\"]") as HTMLButtonElement).click();
  });
  await act(async () => { dialog().dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
  // Closed outright: no discard prompt for an untouched preset.
  expect(document.querySelector("dialog.modal-overlay")).toBeNull();

  // But a real edit still asks.
  await openPicker(container);
  await act(async () => {
    (container.querySelector("[data-preset-id=\"concise\"]") as HTMLButtonElement).click();
  });
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const proto = testWindow.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(textarea, "changed");
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  await act(async () => { dialog().dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
  expect(dialog().querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => { root.unmount(); });
});
