import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Select } from "../src/ui";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Charlie" },
];

async function mountSelect(node: React.ReactElement): Promise<{ root: Root; trigger: HTMLButtonElement }> {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  const trigger = host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  return { root, trigger };
}

function key(target: HTMLElement, name: string) {
  target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as KeyboardEvent);
}

test("ArrowDown opens and Enter selects the active option (portal)", async () => {
  let value = "a";
  const { root, trigger } = await mountSelect(
    <Select value={value} options={OPTIONS} onChange={next => { value = next; }} label="Pick" />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  expect(trigger.getAttribute("aria-activedescendant")).toBeTruthy();
  await act(async () => { key(trigger, "ArrowDown"); });
  await act(async () => { key(trigger, "Enter"); });
  expect(value).toBe("b");
  expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("Home/End and Escape restore focus for non-portal Select", async () => {
  let value = "b";
  const { root, trigger } = await mountSelect(
    <Select value={value} options={OPTIONS} onChange={next => { value = next; }} label="Lang" portal={false} placement="right" />,
  );
  await act(async () => { key(trigger, "End"); });
  await act(async () => { key(trigger, "Enter"); });
  expect(value).toBe("c");
  await act(async () => { key(trigger, "Home"); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { key(trigger, "Escape"); });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("disabled Select does not open from keyboard or click", async () => {
  const { root, trigger } = await mountSelect(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Off" disabled />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { trigger.click(); });
  expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { root.unmount(); });
});

test("outside click closes the menu", async () => {
  const { root, trigger } = await mountSelect(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Pick" />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { root.unmount(); });
});
