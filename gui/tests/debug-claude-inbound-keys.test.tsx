import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DebugClaudeInboundPanel } from "../src/pages/debug-claude-inbound-panel";
import type { ClaudeInboundEntry } from "../src/pages/debug-shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

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

test("Claude inbound rows with identical at/endpoint/model stay distinct via capture id", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const shared = {
    at: 1_700_000_000_000,
    endpoint: "messages",
    model: "claude-opus-4-8-ncb",
    hasMetadataUserId: false,
    hasSystem: false,
  } as const;

  const entries: ClaudeInboundEntry[] = [
    { ...shared, id: 11, thinkingType: "adaptive", outputConfigEffort: "max" },
    { ...shared, id: 12, thinkingType: "enabled", thinkingBudgetTokens: 10000 },
  ];

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DebugClaudeInboundPanel entries={entries} />
      </LanguageProvider>,
    );
  });

  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("adaptive");
  expect(rows[0]?.textContent).toContain("max");
  expect(rows[1]?.textContent).toContain("enabled");
  expect(rows[1]?.textContent).toContain("10000");

  // Update the second row only — unique keys must keep the first row intact.
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DebugClaudeInboundPanel
          entries={[
            entries[0]!,
            { ...entries[1]!, thinkingType: "disabled", thinkingBudgetTokens: undefined },
          ]}
        />
      </LanguageProvider>,
    );
  });

  const updated = container.querySelectorAll("tbody tr");
  expect(updated).toHaveLength(2);
  expect(updated[0]?.textContent).toContain("adaptive");
  expect(updated[0]?.textContent).toContain("max");
  expect(updated[1]?.textContent).toContain("disabled");
  expect(updated[1]?.textContent).not.toContain("10000");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
