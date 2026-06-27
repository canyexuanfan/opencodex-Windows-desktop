import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexAutoStartEnabled,
  getConfigPath,
  getDefaultConfig,
  getPidPath,
  isValidProviderName,
  isOcxStartCommandLine,
  loadConfig,
  parsePidFile,
  removePid,
  writePid,
} from "../src/config";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

function backupNames(): string[] {
  return readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
}

function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

describe("opencodex config defaults", () => {
  test("Codex autostart is enabled by default", () => {
    expect(getDefaultConfig().codexAutoStart).toBe(true);
    expect(codexAutoStartEnabled({})).toBe(true);
  });

  test("Codex autostart can be disabled explicitly", () => {
    expect(codexAutoStartEnabled({ codexAutoStart: false })).toBe(false);
    expect(codexAutoStartEnabled({ codexAutoStart: true })).toBe(true);
  });

  test("loads valid config from OPENCODEX_HOME", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    expect(loadConfig()).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAutoStart: false,
    });
  });

  test("resolves relative OPENCODEX_HOME once to an absolute config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-parent-"));
    const oldCwd = process.cwd();
    try {
      process.env.OPENCODEX_HOME = "relative-home";
      process.chdir(parent);
      const firstPath = getConfigPath();
      const expectedConfigDir = resolve("relative-home");

      process.chdir(tmpdir());

      expect(firstPath).toBe(join(expectedConfigDir, "config.json"));
      expect(getConfigPath()).toBe(firstPath);
      expect(getPidPath()).toBe(join(expectedConfigDir, "ocx.pid"));
    } finally {
      process.chdir(oldCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the default home when OPENCODEX_HOME is unset", () => {
    delete process.env.OPENCODEX_HOME;

    expect(getConfigPath()).toBe(join(homedir(), ".opencodex", "config.json"));
    expect(getPidPath()).toBe(join(homedir(), ".opencodex", "ocx.pid"));
  });

  test("loads UTF-8 BOM config files written by Windows tools", () => {
    writeFileSync(
      getConfigPath(),
      `\uFEFF${JSON.stringify({
        port: 23456,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
        },
        defaultProvider: "custom",
      })}`,
      "utf-8",
    );

    expect(loadConfig()).toMatchObject({
      port: 23456,
      defaultProvider: "custom",
    });
  });

  test("backs up invalid JSON config before falling back to defaults", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(testDir, backups[0]), "utf-8")).toBe("{ invalid json");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not load opencodex config"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("repairs structurally incomplete config by merging defaults instead of rejecting", () => {
    writeConfig({ port: 10100 });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      // Merge should fill in missing providers and defaultProvider from defaults
      expect(loaded.port).toBe(10100);
      expect(loaded.defaultProvider).toBe("openai");
      expect(loaded.providers).toBeDefined();
      // No backup created — config was repaired, not rejected
      const backups = backupNames();
      expect(backups).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("repaired"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("backs up config when defaultProvider is absent from providers", () => {
    writeConfig({
      port: 10100,
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      defaultProvider: "missing",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("provider names reject namespace-breaking and reserved object keys", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("ollama-cloud")).toBe(true);
    expect(isValidProviderName("openrouter/custom")).toBe(false);
    expect(isValidProviderName("__proto__")).toBe(false);
    expect(isValidProviderName("constructor")).toBe(false);
  });

  test("backs up config when defaultProvider only exists on Object prototype", () => {
    writeConfig({
      port: 10100,
      providers: {},
      defaultProvider: "constructor",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("warns and backs up once per invalid config path", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(loadConfig()).toEqual(getDefaultConfig());
      expect(loadConfig()).toEqual(getDefaultConfig());

      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("parses pid files", () => {
    expect(parsePidFile("12345")).toBe(12345);
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("12x")).toBeNull();
    expect(parsePidFile("not-json")).toBeNull();
  });

  test("recognizes opencodex start command lines", () => {
    expect(isOcxStartCommandLine('bun run src/cli.ts start')).toBe(true);
    expect(isOcxStartCommandLine('"C:/tools/bun/bin/bun.exe" "run" "src/cli.ts" "start"')).toBe(true);
    expect(isOcxStartCommandLine('bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start')).toBe(true);
    expect(isOcxStartCommandLine("opencodex start")).toBe(true);

    expect(isOcxStartCommandLine("bun run src/cli.ts status")).toBe(false);
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid file as a numeric pid", () => {
    writePid(process.pid);

    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("removes pid file only when the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });
});
