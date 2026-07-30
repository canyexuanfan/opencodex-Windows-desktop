import { afterEach, describe, expect, test } from "bun:test";
import {
  clearGatherRoutedModelsInflight,
  gatherRoutedModels as gatherRoutedModelsDirect,
  resetCatalogRuntimeStateForTests,
  type ComboCatalogOmission,
} from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests();
});

describe("gatherRoutedModels single-flight", () => {
  test("concurrent callers with the same provider set share one upstream discovery", async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    globalThis.fetch = (async () => {
      fetchCount += 1;
      await gate;
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "slow",
      providers: {
        slow: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          models: [],
        },
      },
    };

    const first = gatherRoutedModels(config);
    const second = gatherRoutedModels(config);
    // Both must have joined before the live fetch resolves.
    await Promise.resolve();
    expect(fetchCount).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchCount).toBe(1);
    expect(a.map(m => `${m.provider}/${m.id}`)).toEqual(["slow/model-a"]);
    expect(b).toEqual(a);
  });

  test("joiners still receive comboOmissions from the shared flight", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          models: [],
        },
      },
      combos: {
        incomplete: {
          strategy: "failover",
          stickyLimit: 1,
          defaultEffort: "medium",
          alias: null,
          targets: [
            { provider: "a", model: "m1", weight: 1 },
            { provider: "missing", model: "x", weight: 1 },
          ],
        },
      },
    };

    const omissionsA: ComboCatalogOmission[] = [];
    const omissionsB: ComboCatalogOmission[] = [];
    await Promise.all([
      gatherRoutedModels(config, { comboOmissions: omissionsA }),
      gatherRoutedModels(config, { comboOmissions: omissionsB }),
    ]);
    expect(omissionsA.some(item => item.id === "incomplete")).toBe(true);
    expect(omissionsB).toEqual(omissionsA);
  });

  test("distinct provider sets keep separate in-flight gathers (no slot eviction)", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const fetchByHost = new Map<string, number>();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = url.includes("provider-a") ? "a" : url.includes("provider-b") ? "b" : "other";
      fetchByHost.set(host, (fetchByHost.get(host) ?? 0) + 1);
      if (host === "a") await gateA;
      else await gateB;
      return new Response(JSON.stringify({ data: [{ id: `model-${host}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const configA: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://provider-a.example.test/v1",
          models: [],
        },
      },
    };
    const configB: OcxConfig = {
      port: 10100,
      defaultProvider: "b",
      providers: {
        b: {
          adapter: "openai-chat",
          baseUrl: "https://provider-b.example.test/v1",
          models: [],
        },
      },
    };

    const firstA = gatherRoutedModels(configA);
    const firstB = gatherRoutedModels(configB);
    const secondA = gatherRoutedModels(configA);
    await Promise.resolve();
    expect(fetchByHost.get("a")).toBe(1);
    expect(fetchByHost.get("b")).toBe(1);

    releaseA();
    releaseB();
    const [a1, b1, a2] = await Promise.all([firstA, firstB, secondA]);
    expect(fetchByHost.get("a")).toBe(1);
    expect(fetchByHost.get("b")).toBe(1);
    expect(a1.map(m => `${m.provider}/${m.id}`)).toEqual(["a/model-a"]);
    expect(b1.map(m => `${m.provider}/${m.id}`)).toEqual(["b/model-b"]);
    expect(a2).toEqual(a1);
  });
});
