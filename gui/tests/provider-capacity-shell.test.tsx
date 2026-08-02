import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const recoveryAt = Date.UTC(2026, 7, 8, 4, 32);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      const body = url.includes("/api/provider-quotas") ? {
        reports: [{
          provider: "openai",
          label: "OpenAI (Codex login)",
          source: "chatgpt:wham",
          updatedAt: Date.now(),
          quota: { weeklyPercent: 30.8, updatedAt: Date.now() },
          aggregation: {
            kind: "capacity-weighted-v1",
            scope: "routable-known",
            includedAccounts: 2,
            excludedAccounts: 1,
            unknownPlanAccounts: 1,
            missingQuotaAccounts: 0,
            pausedAccounts: 0,
            reauthAccounts: 0,
            staleQuotaAccounts: 0,
            incomplete: true,
            weekly: { usedPercent: 30.8, includedAccounts: 2, updatedAt: Date.now(), nextRecoveryAt: recoveryAt, nextRecoveryPercent: 19.2 },
            currentAccount: { isMain: true, plan: "pro", quota: { weeklyPercent: 8, updatedAt: Date.now() } },
          },
        }],
      } : {};
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("provider quota fetch preserves aggregate capacity through shell state and render", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderWorkspaceShell
          providers={{ openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } } as never}
          apiBase=""
          defaultProvider="openai"
          selectedName={null}
          onSelect={() => {}}
          onAddProvider={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

  const text = host.textContent ?? "";
  expect(text).toContain("Configured-weight pool estimate");
  expect(text).toContain("31% used");
  expect(text).toContain("Current effective account · pro");
  expect(text).toContain("8%");
  expect(text).toContain("Incomplete coverage: 1 account(s) excluded, including 1 unknown plan(s)");
  expect(text).toContain("Next capacity recovery");
  expect(text).toContain("+19.2% pool capacity");
  expect(text).toMatch(/Aug 8, 2026.*(4:32|1:32)/);
  expect(text).not.toMatch(/configured units|weighted units|units remaining|projected/i);
});
