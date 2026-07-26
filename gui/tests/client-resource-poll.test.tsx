import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { useClientResource } from "../src/client-resource";

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

test("after the latest subscriber unmounts, polling continues with the surviving loader", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const calls: string[] = [];
  const KEY = `poll-survivors-${Date.now()}`;

  function Subscriber({
    label,
    pollMs,
  }: {
    label: string;
    pollMs: number;
  }) {
    useClientResource(
      KEY,
      async () => {
        calls.push(label);
        return label;
      },
      { pollMs },
    );
    return <span data-label={label} />;
  }

  function Harness() {
    const [showLatest, setShowLatest] = useState(true);
    useEffect(() => {
      (window as unknown as { __dropLatest?: () => void }).__dropLatest = () => setShowLatest(false);
    }, []);
    return (
      <>
        <Subscriber label="survivor" pollMs={40} />
        {showLatest ? <Subscriber label="latest" pollMs={40} /> : null}
      </>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  // Initial subscribe fetch(es) from both subscribers sharing one store (first only fetches).
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
  });
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const beforeUnmount = calls.length;

  await act(async () => {
    (window as unknown as { __dropLatest: () => void }).__dropLatest();
  });

  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 130));
  });

  const afterUnmount = calls.slice(beforeUnmount);
  expect(afterUnmount.length).toBeGreaterThan(0);
  expect(afterUnmount.every((label) => label === "survivor")).toBe(true);
  expect(afterUnmount.some((label) => label === "latest")).toBe(false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
