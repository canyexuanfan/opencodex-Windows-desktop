import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const item = {
  name: "openai",
  adapter: "openai-responses",
  baseUrl: "https://example.test/v1",
  note: "existing note",
} as WorkspaceItem;

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

async function mountOverview(
  onUpdateProvider: (name: string, patch: { note?: string }) => Promise<{ ok: boolean; error?: string }>,
  providerItem = item,
): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderOverview item={providerItem} onUpdateProvider={onUpdateProvider} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

async function openNotesEditor(container: HTMLElement): Promise<HTMLTextAreaElement> {
  const display = container.querySelector<HTMLButtonElement>(".pws-notes-display")!;
  await act(async () => {
    display.click();
  });
  const textarea = container.querySelector<HTMLTextAreaElement>(".pws-notes-textarea")!;
  expect(textarea).toBeTruthy();
  return textarea;
}

async function setDraft(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!
      .set!.call(textarea, value);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

async function blurNotes(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new testWindow.FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: null,
    }));
    await flush();
  });
}

test("notes save keeps editor open, draft, and error when update is rejected", async () => {
  let calls = 0;
  const onUpdateProvider = async () => {
    calls += 1;
    return { ok: false as const, error: "quota exceeded" };
  };

  const { root, container } = await mountOverview(onUpdateProvider);
  const textarea = await openNotesEditor(container);
  await setDraft(textarea, "draft that must survive");
  await blurNotes(textarea);

  expect(calls).toBe(1);
  expect(container.querySelector(".pws-notes-textarea")).toBeTruthy();
  expect(container.querySelector<HTMLTextAreaElement>(".pws-notes-textarea")!.value).toBe("draft that must survive");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("quota exceeded");
  expect(container.querySelector<HTMLTextAreaElement>(".pws-notes-textarea")!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("notes save closes editor only after an acknowledged success", async () => {
  let resolveUpdate!: (value: { ok: true }) => void;
  const updatePromise = new Promise<{ ok: true }>(resolve => {
    resolveUpdate = resolve;
  });
  let calls = 0;
  const onUpdateProvider = async () => {
    calls += 1;
    return updatePromise;
  };

  const { root, container } = await mountOverview(onUpdateProvider);
  const textarea = await openNotesEditor(container);
  await setDraft(textarea, "saved note");
  await blurNotes(textarea);

  expect(calls).toBe(1);
  expect(container.querySelector(".pws-notes-textarea")).toBeTruthy();
  expect(container.querySelector<HTMLTextAreaElement>(".pws-notes-textarea")!.disabled).toBe(true);

  await act(async () => {
    resolveUpdate({ ok: true });
    await flush();
  });

  expect(container.querySelector(".pws-notes-textarea")).toBeNull();
  expect(container.querySelector(".pws-notes-display")?.textContent).toContain("existing note");

  await act(async () => { root.unmount(); });
});
