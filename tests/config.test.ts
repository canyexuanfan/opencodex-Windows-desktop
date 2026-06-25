import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAutoStartEnabled, getConfigPath, getDefaultConfig, loadConfig } from "../src/config";

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

  test("backs up structurally invalid config before falling back to defaults", () => {
    writeConfig({ port: 10100 });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(testDir, backups[0]), "utf-8"))).toEqual({ port: 10100 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("providers"));
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
});
