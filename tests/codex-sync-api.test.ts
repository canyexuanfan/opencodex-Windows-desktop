import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncModelsToCodex } from "../src/codex/sync";
import type { OcxConfig } from "../src/types";
import type { OrcaCodexHomeDiagnostic } from "../src/codex/home";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-sync-api");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let prevCodexHome: string | undefined;

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

function homeDiagnostic(overrides: Partial<OrcaCodexHomeDiagnostic> = {}): OrcaCodexHomeDiagnostic {
  return {
    applicable: false,
    mismatch: false,
    effectiveCodexHome: "C:\\Users\\[USER]\\.codex",
    appCodexHome: "C:\\Users\\[USER]\\.codex",
    orcaCodexHome: null,
    warning: null,
    action: null,
    ...overrides,
  };
}

describe("GUI/CLI Codex sync backend", () => {
  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });
  test("returns the structured sync result used by POST /api/sync", async () => {
    let injectedPort = 0;
    let injectedCatalogPath: string | null | undefined;

    const logs: string[] = [];
    const errors: string[] = [];
    const result = await syncModelsToCodex(12345, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      refreshCodexModelCatalog: async () => ({
        added: 3,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        cacheSynced: true,
      }),
      injectCodexConfig: async (port, _config, options) => {
        injectedPort = port;
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected" };
      },
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(injectedPort).toBe(12345);
    expect(injectedCatalogPath).toBe("/tmp/opencodex-catalog.json");
    expect(result).toEqual({
      ok: true,
      added: 3,
      catalogPath: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      cacheSynced: true,
      message: "injected",
    });
    expect(logs).toContain("   Target Codex home: C:\\Users\\[USER]\\.codex");
    expect(errors).toEqual([]);
  });

  test("keeps injection fallback behavior when catalog refresh throws", async () => {
    let injectedCatalogPath: string | null | undefined = "unset";

    const result = await syncModelsToCodex(undefined, config, null, {
      refreshCodexModelCatalog: async () => {
        throw new Error("catalog boom");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected fallback" };
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(injectedCatalogPath).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.catalogPath).toBeNull();
    expect(result.warning).toContain("catalog boom");
  });

  test("skips catalog refresh before preserving an external provider", async () => {
    let refreshed = false;
    let injectedCatalogPath: string | null | undefined = "unset";
    const logs: string[] = [];
    const errors: string[] = [];
    const mismatch = homeDiagnostic({
      applicable: true,
      mismatch: true,
      effectiveCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      orcaCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      warning: "Orca target does not reach the app",
      action: "migrate the installed service",
    });
    const result = await syncModelsToCodex(10100, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "external provider preserved" };
      },
      currentExternalCodexModelProvider: () => "custom",
      collectCodexHomeDiagnostic: () => mismatch,
    });

    expect(refreshed).toBe(false);
    expect(injectedCatalogPath).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: false,
      message: "external provider preserved",
    });
    expect(logs).toContain(`   Target Codex home: ${mismatch.effectiveCodexHome}`);
    expect(errors).toEqual([
      `WARNING: ${mismatch.warning}`,
      `Action: ${mismatch.action}`,
    ]);
  });
});
