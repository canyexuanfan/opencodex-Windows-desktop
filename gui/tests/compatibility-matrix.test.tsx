/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CompatibilityMatrix from "../src/pages/CompatibilityMatrix";
import {
  buildMatrixRows,
  filterVerdicts,
  parseVerdictPage,
  shortSubjectId,
} from "../src/pages/compatibility-matrix-shared";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const STATUS_AVAILABLE = {
  projectionAvailable: true,
  subjectCount: 1,
  verdictCount: 2,
  observationCount: 4,
  eventCount: 5,
  builtAtMs: 1_700_000_000_000,
};

const VERDICTS = {
  verdicts: [
    {
      projectionKey: "k1",
      subjectId: "subject-alpha",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-a",
      projectionSpecVersion: "cl-02.v1",
      verdict: "VERIFIED",
      asOf: 1_700_000_000_100,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: ["e1"],
      contradictingEventIds: [],
      notes: [],
    },
    {
      projectionKey: "k2",
      subjectId: "subject-alpha",
      evidenceLayer: "live_route_compatibility",
      suiteId: "live-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-b",
      projectionSpecVersion: "cl-02.v1",
      verdict: "PROBED",
      asOf: 1_700_000_000_200,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: ["e2"],
      contradictingEventIds: [],
      notes: [],
    },
  ],
  hasMore: false,
};

const SUBJECTS = {
  subjects: [{ subjectId: "subject-alpha", subjectKind: "protocol" }],
  hasMore: false,
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
    }
  };
});

afterEach(() => {
  restoreGlobals?.();
  globalThis.fetch = originalFetch;
  testWindow.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

async function renderPage(): Promise<{ root: Root; container: HTMLDivElement }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <CompatibilityMatrix apiBase="http://127.0.0.1:4096" />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

test("parseVerdictPage rejects malformed payloads", () => {
  expect(parseVerdictPage(null).verdicts).toEqual([]);
  expect(parseVerdictPage({ verdicts: [{ subjectId: "x" }] }).verdicts).toEqual([]);
});

test("buildMatrixRows groups verdicts by subject and layer", () => {
  const page = parseVerdictPage(VERDICTS);
  const rows = buildMatrixRows(page.verdicts, SUBJECTS.subjects);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.byLayer.protocol_conformance).toHaveLength(1);
  expect(rows[0]!.byLayer.live_route_compatibility).toHaveLength(1);
  expect(rows[0]!.byLayer.task_effectiveness).toHaveLength(0);
});

test("filterVerdicts applies layer and subject filters", () => {
  const page = parseVerdictPage(VERDICTS);
  const filtered = filterVerdicts(page.verdicts, {
    layer: "protocol_conformance",
    verdict: "",
    subjectQuery: "alpha",
  });
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.verdict).toBe("VERIFIED");
});

test("shortSubjectId keeps short ids intact", () => {
  expect(shortSubjectId("abc")).toBe("abc");
  expect(shortSubjectId("012345678901234567890")).toContain("…");
});

test("CompatibilityMatrix renders matrix rows from lab APIs", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/lab/status")) {
      return new Response(JSON.stringify(STATUS_AVAILABLE), { status: 200 });
    }
    if (url.includes("/api/lab/verdicts")) {
      return new Response(JSON.stringify(VERDICTS), { status: 200 });
    }
    if (url.includes("/api/lab/subjects")) {
      return new Response(JSON.stringify(SUBJECTS), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const { root, container } = await renderPage();
  await waitFor(() => container.textContent?.includes("Compatibility matrix") ?? false);
  expect(container.textContent).toContain("Verified");
  expect(container.textContent).toContain("Probed");
  expect(container.querySelector(".lab-matrix tbody tr")).not.toBeNull();
  await act(async () => root.unmount());
});

test("CompatibilityMatrix shows unavailable state when projection is missing", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/lab/status")) {
      return new Response(JSON.stringify({ projectionAvailable: false }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const { root, container } = await renderPage();
  await waitFor(() => container.textContent?.includes("not available") ?? false);
  expect(container.querySelector(".lab-matrix")).toBeNull();
  await act(async () => root.unmount());
});
