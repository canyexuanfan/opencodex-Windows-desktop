/**
 * The base-prompt variant picker (devlog 020, amended by 021).
 *
 * Three properties matter and each would be wrong alone: the default is unreachable by
 * an editor, the ring moves by swipe AND by keyboard, and the external state refuses to
 * act rather than retargeting a key somebody else set.
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

const VARIANTS = [
  { id: "aaa111", title: "Terse", body: "Be brief.", bytes: 20 },
  { id: "bbb222", title: "Formal", body: "Answer formally.", bytes: 26 },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: false,
    developerInstructionsState: "absent" as const,
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

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }
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

function baseRow(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-layer-id="base-instructions"]') as HTMLElement;
}

async function openBaseDialog(container: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    (baseRow(container).querySelector(".codex-set-prompt__name") as HTMLButtonElement).click();
  });
  return document.querySelector("dialog.codex-set-base-dialog") as HTMLElement;
}

function position(dlg: HTMLElement): string {
  return (dlg.querySelector(".codex-set-base-dialog__pos")?.textContent ?? "").trim();
}

function slotKind(dlg: HTMLElement): string | null {
  return dlg.querySelector(".codex-set-base-dialog__pos")?.getAttribute("data-slot-kind") ?? null;
}
test("the base row carries a switch that reads on for the default", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const sw = baseRow(container).querySelector('button[role="switch"]') as HTMLButtonElement;
  // A real switch, not a disabled placeholder: base now has an off-position.
  expect(sw).not.toBeNull();
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(sw.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("the default slot has no editor and no Save, and says why", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  expect(slotKind(dlg)).toBe("default");
  // Read-only by construction. Asserting the ABSENCE of the inputs is the point: a
  // disabled textarea would still tell the user a body exists to edit.
  expect(dlg.querySelector("textarea")).toBeNull();
  expect(dlg.querySelector("input")).toBeNull();
  const labels = [...dlg.querySelectorAll("button")].map(b => (b.textContent ?? "").toLowerCase());
  expect(labels.some(l => l.includes("save"))).toBe(false);
  expect(labels.some(l => l.includes("delete"))).toBe(false);
  // And it explains itself rather than just withholding controls.
  expect(dlg.textContent ?? "").toContain("model_instructions_file");
  await act(async () => { root.unmount(); });
});

test("the arrow buttons step the ring and it wraps at both ends", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + two variants; the new slot is absent because the cap is reached.
  expect(position(dlg)).toBe("1 / 3");

  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  const prev = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[0] as HTMLButtonElement;
  await act(async () => { next.click(); });
  expect(position(dlg)).toBe("2 / 3");
  expect(slotKind(dlg)).toBe("variant");
  // The editor follows the slot.
  expect((dlg.querySelector("input") as HTMLInputElement).value).toBe("Terse");

  await act(async () => { next.click(); });
  expect((dlg.querySelector("input") as HTMLInputElement).value).toBe("Formal");

  // Wrap forward, then wrap backward: a three-slot ring must not dead-end.
  await act(async () => { next.click(); });
  expect(position(dlg)).toBe("1 / 3");
  await act(async () => { prev.click(); });
  expect(position(dlg)).toBe("3 / 3");
  await act(async () => { root.unmount(); });
});

test("ArrowRight and ArrowLeft step the ring, but not while typing", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  const key = (target: EventTarget, k: string) => {
    const event = new testWindow.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event as unknown as Event);
  };

  await act(async () => { key(dlg, "ArrowRight"); });
  expect(position(dlg)).toBe("2 / 3");
  await act(async () => { key(dlg, "ArrowLeft"); });
  expect(position(dlg)).toBe("1 / 3");

  // A textarea is where the prompt is written, so an arrow key there is cursor
  // movement. Navigating on it would move the user off the text they are editing.
  await act(async () => { key(dlg, "ArrowRight"); });
  const textarea = dlg.querySelector("textarea")!;
  const before = position(dlg);
  await act(async () => { key(textarea, "ArrowRight"); });
  expect(position(dlg)).toBe(before);
  await act(async () => { root.unmount(); });
});

test("a horizontal swipe steps the ring; a vertical drag does not", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  const pointer = (type: string, x: number, y: number) => {
    const event = new testWindow.Event(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
    Object.defineProperty(event, "clientX", { value: x });
    Object.defineProperty(event, "clientY", { value: y });
    dlg.dispatchEvent(event as unknown as Event);
  };

  // Left-to-right past the threshold moves backward, which wraps to the last slot.
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 20, 104); });
  expect(position(dlg)).toBe("2 / 3");

  // Mostly VERTICAL travel is a scroll, even though its horizontal component clears
  // the threshold. Without the dominance check, reading a long prompt throws the
  // user onto another variant mid-scroll.
  const held = position(dlg);
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 130, 600); });
  expect(position(dlg)).toBe(held);

  // And a small horizontal jitter is not a swipe either.
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 180, 100); });
  expect(position(dlg)).toBe(held);
  await act(async () => { root.unmount(); });
});

test("choosing a variant PUTs the selection with the current revision", async () => {
  const calls = stubRoutes(call => (call.method === "PUT"
    ? json({ ok: true, snapshot: snapshot({ baseVariants: VARIANTS, baseSelection: { kind: "variant", id: "aaa111" }, revision: "sha256:two" }) })
    : json(snapshot({ baseVariants: VARIANTS }))));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });

  const use = [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("use")) as HTMLButtonElement;
  await act(async () => { use.click(); });

  const put = calls.find(c => c.method === "PUT")!;
  expect(put.url).toContain("/api/codex-prompt/base/select");
  expect(put.body).toMatchObject({ kind: "variant", id: "aaa111", revision: "sha256:one" });
  await act(async () => { root.unmount(); });
});

test("the external state blocks the picker instead of retargeting the key", async () => {
  const calls = stubRoutes(() => json(snapshot({
    baseVariants: VARIANTS,
    baseSelection: { kind: "external", path: "/etc/somebody-elses.md" },
  })));
  const { container, root } = await mount();

  // The switch cannot claim Codex own prompt is in force when it is not.
  const sw = baseRow(container).querySelector('button[role="switch"]') as HTMLButtonElement;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(sw.disabled).toBe(true);

  const dlg = await openBaseDialog(container);
  expect(dlg.querySelector(".notice-err")).not.toBeNull();
  expect(dlg.textContent ?? "").toContain("/etc/somebody-elses.md");

  // Every action is inert, and nothing was written on the way to finding out.
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  for (const button of [...dlg.querySelectorAll(".modal-actions button")] as HTMLButtonElement[]) {
    const label = (button.textContent ?? "").toLowerCase();
    if (label.includes("close")) continue;
    expect(button.disabled, label).toBe(true);
  }
  expect(calls.every(c => c.method === "GET")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("the new slot appears only while there is room under the cap", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: [VARIANTS[0]!] })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + one variant + one empty slot: adding is the same gesture as choosing.
  expect(position(dlg)).toBe("1 / 3");
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  await act(async () => { next.click(); });
  expect(slotKind(dlg)).toBe("new");
  // An empty slot has an editor but nothing to delete or select yet.
  expect(dlg.querySelector("textarea")).not.toBeNull();
  const labels = [...dlg.querySelectorAll(".modal-actions button")].map(b => (b.textContent ?? "").toLowerCase());
  expect(labels.some(l => l.includes("delete"))).toBe(false);
  await act(async () => { root.unmount(); });
});

test("the dot indicator renders one dot per slot and marks the active one", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: [VARIANTS[0]!] })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + one variant + one empty slot = 3 dots
  const dots = dlg.querySelectorAll(".codex-set-base-dialog__dot");
  expect(dots.length).toBe(3);
  expect(dots[0]!.classList.contains("active")).toBe(true);
  expect(dots[1]!.classList.contains("active")).toBe(false);
  // Step forward and the active dot moves
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  const dotsAfter = dlg.querySelectorAll(".codex-set-base-dialog__dot");
  expect(dotsAfter[0]!.classList.contains("active")).toBe(false);
  expect(dotsAfter[1]!.classList.contains("active")).toBe(true);
  await act(async () => { root.unmount(); });
});
