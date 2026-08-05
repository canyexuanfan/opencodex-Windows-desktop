/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import RoutingProfiles from "../src/pages/RoutingProfiles";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const PROFILE = {
  id: "balanced",
  model: "policy/balanced",
  revision: "rev-abc",
  candidates: [
    { provider: "openai", model: "gpt-5" },
    { provider: "anthropic", model: "claude-sonnet-4" },
  ],
  require: { tools: true },
  optimize: { latency: 0.4, reliability: 0.6 },
  limits: { maxEstimatedCostUsd: 0.5 },
  unknownEvidence: { capability: "exclude", health: "penalize" },
};

const ANALYTICS = {
  totalRequests: 12,
  successRate: 0.75,
  fallbackRate: 0.1,
  confidence: "medium",
  historyTruncated: true,
  cooldownTriggeringFailures: 2,
  durationMs: { p50: 120, p95: 400, p99: 900, sampleCount: 12 },
  firstOutputMs: { p50: 40, p95: 90, p99: 180, sampleCount: 10, coverage: 0.8 },
  breakdown: [
    { provider: "openai", model: "gpt-5", requests: 8, successRate: 0.875, p50DurationMs: 100 },
    { provider: "anthropic", model: "claude-sonnet-4", requests: 4, successRate: 0.5, p50DurationMs: 180 },
  ],
};

const DRY_RUN_OK = {
  selectedIndex: 0,
  candidates: [
    {
      provider: "openai",
      model: "gpt-5",
      eligible: true,
      exclusions: [],
      score: { total: 0.91, components: { reliability: 0.5, latency: 0.41 } },
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-4",
      eligible: false,
      exclusions: [{ code: "unknown-capability", detail: "tools" }],
      score: { total: 0.2, components: { reliability: 0.2 } },
    },
  ],
  trace: { profile: { revision: "rev-abc" } },
};

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost/" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
  testWindow.close();
});

async function tick(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

async function mountPage(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLDivElement;
  testWindow.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RoutingProfiles apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await tick(3);
  return { container, root };
}

test("routing page loads profiles, analytics, and marks the dry-run selection", async () => {
  const dryRunBodies: unknown[] = [];
  installFetch((url, init) => {
    if (url.endsWith("/api/routing-profiles") && (init?.method ?? "GET") === "GET") {
      return Response.json({ profiles: [PROFILE] });
    }
    if (url.endsWith("/api/routing-analytics")) {
      return Response.json(ANALYTICS);
    }
    if (url.endsWith("/api/routing-profiles/dry-run") && init?.method === "POST") {
      dryRunBodies.push(JSON.parse(String(init.body ?? "{}")));
      return Response.json(DRY_RUN_OK);
    }
    return new Response("missing", { status: 404 });
  });

  const { container, root } = await mountPage();
  try {
    expect(container.querySelector('[data-page="routing"]')).toBeTruthy();
    expect(container.textContent).toContain("Routing Intelligence");
    expect(container.textContent).toContain("balanced");
    expect(container.textContent).toContain("policy/balanced");
    expect(container.textContent).toContain("rev-abc");
    expect(container.textContent).toContain("openai/gpt-5");
    expect(container.textContent).toContain("Requests: 12");
    expect(container.textContent).toContain("Success: 75%");
    expect(container.textContent).toContain("truncated history");

    const evaluate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Evaluate candidates"));
    expect(evaluate).toBeTruthy();
    await act(async () => { evaluate!.click(); });
    await tick(3);

    expect(dryRunBodies).toEqual([{ profile: "balanced", evidence: {} }]);
    expect(container.textContent).toContain("selected");
    expect(container.textContent).toContain("unknown-capability");
    expect(container.textContent).toContain("0.910");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("routing dry-run checks response status before treating the body as success", async () => {
  installFetch((url, init) => {
    if (url.endsWith("/api/routing-profiles") && (init?.method ?? "GET") === "GET") {
      return Response.json({ profiles: [PROFILE] });
    }
    if (url.endsWith("/api/routing-analytics")) {
      return Response.json(ANALYTICS);
    }
    if (url.endsWith("/api/routing-profiles/dry-run") && init?.method === "POST") {
      return Response.json({ error: { message: "profile missing" } }, { status: 404 });
    }
    return new Response("missing", { status: 404 });
  });

  const { container, root } = await mountPage();
  try {
    const evaluate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Evaluate candidates"));
    expect(evaluate).toBeTruthy();
    await act(async () => { evaluate!.click(); });
    await tick(3);
    expect(container.textContent).toContain("profile missing");
    expect(container.textContent).not.toContain("0.910");
  } finally {
    await act(async () => { root.unmount(); });
  }
});
