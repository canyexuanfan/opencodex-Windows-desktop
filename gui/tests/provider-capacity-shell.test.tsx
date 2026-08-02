import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import { LanguageProvider } from "../src/i18n/provider";
import { readSessionListCache, writeSessionListCache } from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let quotaPayload: unknown;
let rejectQuotaFetch = false;

const QUOTA_CACHE_KEY = "ocx.providers.quotas.v1:";
const RECOVERY_AT = Date.UTC(2026, 7, 8, 4, 32);
const providers = {
  openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
} as never;

function aggregatePayload() {
  return {
    reports: [{
      provider: "openai",
      label: "OpenAI (Codex login)",
      source: "chatgpt:wham",
      updatedAt: Date.now(),
      quota: { weeklyPercent: 30.8, updatedAt: Date.now() },
      aggregation: {
        kind: "capacity-weighted-v1",
        scope: "routable-known",
        presentation: "aggregate",
        includedAccounts: 2,
        excludedAccounts: 1,
        unknownPlanAccounts: 1,
        missingQuotaAccounts: 0,
        pausedAccounts: 0,
        reauthAccounts: 0,
        staleQuotaAccounts: 0,
        incomplete: true,
        weekly: {
          usedPercent: 30.8,
          includedAccounts: 2,
          excludedAccounts: 1,
          incomplete: true,
          updatedAt: Date.now(),
          nextRecoveryAt: RECOVERY_AT,
          nextRecoveryPercent: 19.2,
        },
        currentAccount: { isMain: true, plan: "pro", quota: { weeklyPercent: 8, updatedAt: Date.now() } },
      },
    }],
  };
}

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
  quotaPayload = aggregatePayload();
  rejectQuotaFetch = false;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      if (url.includes("/api/provider-quotas") && rejectQuotaFetch) throw new Error("quota unavailable");
      const body = url.includes("/api/provider-quotas") ? quotaPayload : {};
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

async function mountShell() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderWorkspaceShell
          providers={providers}
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
}

test("provider quota fetch preserves aggregate capacity through shell state and render", async () => {
  await mountShell();

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

test("successful empty quota response removes cached providers and updates session cache", async () => {
  const seeded = (aggregatePayload().reports[0]);
  const { provider: _provider, ...cached } = seeded;
  writeSessionListCache(QUOTA_CACHE_KEY, { openai: cached });
  quotaPayload = { reports: [] };

  await mountShell();

  expect(host.textContent ?? "").not.toContain("Configured-weight pool estimate");
  expect(readSessionListCache(QUOTA_CACHE_KEY)).toEqual({});
});

test("expired session quota is rejected and a failed fetch cannot keep it rendered", async () => {
  const old = Date.now() - 31 * 60_000;
  writeSessionListCache(QUOTA_CACHE_KEY, {
    openai: {
      label: "OpenAI (Codex login)",
      source: "chatgpt:wham",
      updatedAt: old,
      quota: { weeklyPercent: 99, updatedAt: old },
      aggregation: { ...aggregatePayload().reports[0].aggregation, presentation: "aggregate" },
    },
  });
  rejectQuotaFetch = true;

  await mountShell();

  const text = host.textContent ?? "";
  expect(text).not.toContain("Configured-weight pool estimate");
  expect(text).not.toContain("99% used");
  expect(readSessionListCache(QUOTA_CACHE_KEY)).toEqual({});
});

test("all-stale response renders coverage only without a numeric fallback", async () => {
  const old = Date.now() - 31 * 60_000;
  quotaPayload = {
    reports: [{
      provider: "openai",
      label: "OpenAI (Codex login)",
      source: "chatgpt:wham",
      updatedAt: Date.now(),
      quota: { updatedAt: Date.now() },
      aggregation: {
        kind: "capacity-weighted-v1",
        scope: "routable-known",
        presentation: "coverage-only",
        includedAccounts: 0,
        excludedAccounts: 2,
        unknownPlanAccounts: 0,
        incomplete: true,
        partialWindowAccounts: 0,
        currentAccount: { isMain: true, plan: "pro", quota: null },
      },
    }],
  };

  await mountShell();

  const text = host.textContent ?? "";
  expect(text).not.toContain("Configured-weight pool estimate");
  expect(text).not.toContain("Current effective account");
  expect(text).not.toContain("80% used");
  expect(text).toContain("Incomplete coverage: 2 account(s) excluded");
});

test("coverage-only API report remains visible in the rate-limit overview", async () => {
  quotaPayload = {
    reports: [{
      provider: "openai",
      label: "OpenAI (Codex login)",
      source: "chatgpt:wham",
      updatedAt: Date.now(),
      quota: { updatedAt: Date.now() },
      aggregation: {
        kind: "capacity-weighted-v1",
        scope: "routable-known",
        presentation: "coverage-only",
        includedAccounts: 0,
        excludedAccounts: 3,
        unknownPlanAccounts: 1,
        partialWindowAccounts: 0,
        incomplete: true,
      },
    }],
  };

  await mountShell();

  const text = host.textContent ?? "";
  expect(text).toContain("OpenAI (Codex login)");
  expect(text).toContain("Incomplete coverage: 3 account(s) excluded, including 1 unknown plan(s)");
  expect(text).not.toContain("No rate-limit data yet");
  expect(text).not.toMatch(/\d+(?:\.\d+)?% used/);
});

test("mixed-window coverage uses a distinct warning without whole-account exclusion", async () => {
  const payload = aggregatePayload();
  payload.reports[0].quota = { weeklyPercent: 25, monthlyPercent: 40, updatedAt: Date.now() };
  payload.reports[0].aggregation.excludedAccounts = 0;
  payload.reports[0].aggregation.unknownPlanAccounts = 0;
  payload.reports[0].aggregation.partialWindowAccounts = 2;
  payload.reports[0].aggregation.monthly = {
    usedPercent: 40,
    includedAccounts: 2,
    excludedAccounts: 1,
    incomplete: true,
    updatedAt: Date.now(),
  };
  quotaPayload = payload;

  await mountShell();

  const text = host.textContent ?? "";
  expect(text).toContain("Partial window coverage: 2 account(s) do not report every displayed limit window");
  expect(text).not.toContain("Incomplete coverage: 0 account(s) excluded");
});
