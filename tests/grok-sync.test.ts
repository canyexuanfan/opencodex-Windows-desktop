import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig } from "../src/grok/inject";
import { syncGrokConfig } from "../src/grok/sync";
import type { CatalogModel } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";

const baseConfig = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-sync-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

describe("syncGrokConfig", () => {
  test("injects natives plus routed models with catalog context windows", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const routed: CatalogModel[] = [
        { id: "grok-4.5", provider: "cursor", contextWindow: 500_000 } as CatalogModel,
      ];
      const result = await syncGrokConfig(10190, baseConfig, { grokHome }, {
        fetchAllModels: async () => routed,
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      // Native slugs come from visibleNativeSlugs(config) — at least one gpt native present.
      expect(content).toContain("[model.ocx-gpt-");
      expect(content).toContain("[model.ocx-cursor-grok-4-5]");
      expect(content).toContain("context_window = 500000");
      expect(content).toContain('base_url = "http://127.0.0.1:10190/v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the observed bind hostname reaches injection (ensure live branch)", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      // ensure's live branch passes live.hostname — the host the proxy ACTUALLY bound, which
      // can differ from a drifted config.hostname. A wildcard bind exposes every interface, so
      // injection must refuse rather than write a block that cannot authenticate.
      const wildcard = await syncGrokConfig(10100, baseConfig, { grokHome, hostname: "0.0.0.0" }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(wildcard).toMatchObject({ ok: true, changed: false, skippedReason: "non-loopback" });
      expect(existsSync(join(grokHome, "config.toml"))).toBe(false);

      const loopback = await syncGrokConfig(10100, baseConfig, { grokHome, hostname: "::1" }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(loopback).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(join(grokHome, "config.toml"), "utf8"))
        .toContain('base_url = "http://[::1]:10100/v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("catalog failure surfaces ok:false without touching the config", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = await syncGrokConfig(10100, baseConfig, { grokHome }, {
        fetchAllModels: async () => { throw new Error("proxy down"); },
        injectGrokConfig,
      });
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.message).toContain("proxy down");
      expect(() => readFileSync(join(grokHome, "config.toml"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-sync is idempotent: one fence, latest catalog wins", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const deps = { fetchAllModels: async () => [], injectGrokConfig };
      await syncGrokConfig(10190, baseConfig, { grokHome }, {
        ...deps,
        fetchAllModels: async () => [{ id: "old", provider: "p" } as CatalogModel],
      });
      await syncGrokConfig(10190, baseConfig, { grokHome }, {
        ...deps,
        fetchAllModels: async () => [{ id: "new", provider: "p" } as CatalogModel],
      });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      expect(content.match(/>>> opencodex managed block/g) ?? []).toHaveLength(1);
      expect(content).not.toContain("[model.ocx-p-old]");
      expect(content).toContain("[model.ocx-p-new]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
