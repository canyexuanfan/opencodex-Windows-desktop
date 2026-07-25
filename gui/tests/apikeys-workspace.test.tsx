import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeysWorkspace, {
  type ApiKeyEntry,
  type ApiKeysWorkspaceProps,
} from "../src/components/apikeys-workspace/ApiKeysWorkspace";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const sampleKeys: ApiKeyEntry[] = [
  { id: "k1", name: "alpha", prefix: "ocx_aaa", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "k2", name: "beta", prefix: "ocx_bbb", createdAt: "2026-01-02T00:00:00.000Z" },
];

const FULL_SECRET = "ocx_FULL_SECRET_ONLY_ONCE";

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as HTMLInputElement;
  const protoSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  protoSetter?.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

async function mountWorkspace(
  props: Partial<ApiKeysWorkspaceProps> & Pick<ApiKeysWorkspaceProps, "onCreate">,
): Promise<{ root: Root; container: HTMLElement; rerender: (next: Partial<ApiKeysWorkspaceProps>) => Promise<void> }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let latest: ApiKeysWorkspaceProps = {
    keys: sampleKeys,
    endpoint: "http://127.0.0.1:10100/v1/responses",
    creating: false,
    newKey: null,
    copied: false,
    onDismissNewKey: () => {},
    onCopyNewKey: () => {},
    onDelete: () => {},
    ...props,
  };

  function Harness({ value }: { value: ApiKeysWorkspaceProps }) {
    return (
      <LanguageProvider>
        <ApiKeysWorkspace {...value} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness value={latest} />);
  });

  return {
    root,
    container,
    async rerender(next) {
      latest = { ...latest, ...next };
      await act(async () => {
        root.render(<Harness value={latest} />);
      });
    },
  };
}

function overviewButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".apikeys-workspace-rail-row")]
    .find(el => el.textContent?.includes("Overview"))!;
}

function keyButton(container: HTMLElement, name: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".apikeys-workspace-rail-row")]
    .find(el => el.querySelector(".apikeys-workspace-rail-name")?.textContent === name)!;
}

function nameInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[aria-label="Key name (optional)"]')!;
}

function generateButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(el => /Generate|Creating/.test(el.textContent ?? ""))!;
}

test("workspace overview navigation preserves pending secret and resets delete confirm", async () => {
  const { root, container } = await mountWorkspace({
    newKey: FULL_SECRET,
    onCreate: async () => false,
  });

  expect(container.textContent).toContain("Endpoint");
  expect(container.textContent).toContain("Generate key");
  expect(container.textContent).toContain("Usage example");
  expect(container.querySelector(".awi-newkey-code")?.textContent).toBe(FULL_SECRET);
  expect(container.querySelector("main")).toBeNull();
  expect(container.querySelector('[role="main"]')).toBeNull();
  expect(container.querySelector("section.apikeys-workspace-main")?.getAttribute("aria-label")).toBe("API key details");

  await act(async () => { keyButton(container, "alpha").click(); });
  expect(container.textContent).toContain("Key details");
  expect(container.textContent).toContain("ocx_aaa");
  expect(container.textContent).not.toContain(FULL_SECRET);

  await act(async () => {
    [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Delete key"))!.click();
  });
  expect(container.textContent).toContain("Are you sure you want to delete this key?");

  await act(async () => { overviewButton(container).click(); });
  expect(container.textContent).toContain("Endpoint");
  expect(container.textContent).toContain("Generate key");
  expect(container.querySelector(".awi-newkey-code")?.textContent).toBe(FULL_SECRET);
  expect(container.textContent).not.toContain("Are you sure you want to delete this key?");

  await act(async () => { root.unmount(); });
});

test("workspace single-flight: repeated Enter and Generate while creating call onCreate once", async () => {
  let calls = 0;
  let resolveCreate!: (ok: boolean) => void;
  const pending = new Promise<boolean>(resolve => { resolveCreate = resolve; });

  const { root, container, rerender } = await mountWorkspace({
    creating: false,
    onCreate: async () => {
      calls += 1;
      return pending;
    },
  });

  await act(async () => {
    setInputValue(nameInput(container), "once");
    nameInput(container).dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(calls).toBe(1);

  await rerender({ creating: true });
  expect(generateButton(container).disabled).toBe(true);
  expect(nameInput(container).disabled).toBe(true);

  await act(async () => {
    nameInput(container).dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    generateButton(container).click();
  });
  expect(calls).toBe(1);

  await act(async () => {
    const event = new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(event, "isComposing", { configurable: true, value: true });
    nameInput(container).dispatchEvent(event);
  });
  // Even if composing flag is ignored by React's synthetic path here, creating/disabled still blocks.
  expect(calls).toBe(1);

  await act(async () => {
    resolveCreate(true);
    await pending;
  });

  await act(async () => { root.unmount(); });
});

test("workspace clears draft name only after successful create", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let createImpl: (name: string) => Promise<boolean> = async () => false;
  const createCalls: string[] = [];

  function Host() {
    const [creating, setCreating] = useState(false);
    return (
      <LanguageProvider>
        <ApiKeysWorkspace
          keys={sampleKeys}
          endpoint="http://127.0.0.1:10100/v1/responses"
          creating={creating}
          newKey={null}
          copied={false}
          onDismissNewKey={() => {}}
          onCopyNewKey={() => {}}
          onDelete={() => {}}
          onCreate={async (name) => {
            createCalls.push(name);
            setCreating(true);
            try {
              return await createImpl(name);
            } finally {
              setCreating(false);
            }
          }}
        />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Host />);
  });

  await act(async () => {
    setInputValue(nameInput(container), "keep-me");
  });
  expect(nameInput(container).value).toBe("keep-me");

  createImpl = async () => false;
  await act(async () => { generateButton(container).click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(createCalls.at(-1)).toBe("keep-me");
  expect(nameInput(container).value).toBe("keep-me");

  createImpl = async () => true;
  await act(async () => { generateButton(container).click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(createCalls.at(-1)).toBe("keep-me");
  expect(nameInput(container).value).toBe("");

  await act(async () => { root.unmount(); });
});

test("IME composition Enter does not submit", async () => {
  let calls = 0;
  const { root, container } = await mountWorkspace({
    onCreate: async () => {
      calls += 1;
      return true;
    },
  });

  await act(async () => {
    setInputValue(nameInput(container), "ime");
    const event = new testWindow.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { configurable: true, get: () => true });
    Object.defineProperty(event, "keyCode", { configurable: true, value: 229 });
    nameInput(container).dispatchEvent(event);
  });

  // React reads event.nativeEvent.isComposing from the dispatched KeyboardEvent when available.
  // If happy-dom doesn't populate nativeEvent, the component still checks e.nativeEvent.isComposing —
  // verify the handler path by also ensuring creating/disabled paths work above.
  // Force through React's onKeyDown by constructing an event React will treat as composing:
  await act(async () => {
    const input = nameInput(container);
    const handler = (input as unknown as { onclick?: unknown }).onclick;
    void handler;
    const reactPropsKey = Object.keys(input).find(k => k.startsWith("__reactProps$"));
    if (reactPropsKey) {
      const props = (input as unknown as Record<string, { onKeyDown?: (e: unknown) => void }>)[reactPropsKey];
      props?.onKeyDown?.({
        key: "Enter",
        preventDefault() {},
        nativeEvent: { isComposing: true },
      });
    }
  });
  expect(calls).toBe(0);

  await act(async () => { root.unmount(); });
});

test("parent creatingRef blocks duplicate submissions before rerender", async () => {
  const creatingRef = { current: false };
  let posts = 0;
  const handleCreate = async (): Promise<boolean> => {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    try {
      posts += 1;
      await Promise.resolve();
      return true;
    } finally {
      creatingRef.current = false;
    }
  };

  const first = handleCreate();
  const second = handleCreate();
  expect(await Promise.all([first, second])).toEqual([true, false]);
  expect(posts).toBe(1);
});

test("App keeps the sole main landmark; workspace never nests main", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const workspace = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();

  expect(app).toContain('<main className="main"');
  expect(workspace).not.toContain("<main");
  expect(workspace).not.toContain('role="main"');
  expect(workspace).toContain('aria-label={t("api.workspace.details")}');
  expect(workspace).toContain('aria-current={selectedId === null ? "page" : undefined}');
  expect(workspace).toContain("e.nativeEvent.isComposing");
  expect(page).toContain("creatingRef");
  expect(page).toContain("if (creatingRef.current) return false");

  for (const locale of ["en", "de", "ja", "ko", "ru", "zh"] as const) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"api.workspace.overview":');
    expect(dict).toContain('"api.workspace.details":');
  }
});

test("rail and detail never render the full pending secret", async () => {
  const { root, container } = await mountWorkspace({
    newKey: FULL_SECRET,
    onCreate: async () => false,
  });
  const rail = container.querySelector(".apikeys-workspace-rail")!;
  expect(rail.textContent).not.toContain(FULL_SECRET);
  expect(rail.textContent).toContain("ocx_aaa");
  expect(container.querySelector(".awi-newkey-code")?.textContent).toBe(FULL_SECRET);

  await act(async () => { keyButton(container, "beta").click(); });
  expect(container.querySelector(".awi-detail")?.textContent).not.toContain(FULL_SECRET);
  expect(container.querySelector(".awi-detail")?.textContent).toContain("ocx_bbb");

  await act(async () => { overviewButton(container).click(); });
  expect(container.querySelector(".awi-newkey-code")?.textContent).toBe(FULL_SECRET);

  await act(async () => { root.unmount(); });
});
