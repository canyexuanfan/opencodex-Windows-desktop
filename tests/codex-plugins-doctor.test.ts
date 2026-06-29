import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseCodexBundledPlugins } from "../src/codex-plugins-doctor";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

function makeConfig(body: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocx-codex-home-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, body, "utf8");
  return { dir, configPath };
}

describe("diagnoseCodexBundledPlugins (direct, platform-injected)", () => {
  test("non-Windows is reported as not applicable", () => {
    const result = diagnoseCodexBundledPlugins({ platform: "darwin" });
    expect(result.applicable).toBe(false);
    if (!result.applicable) expect(result.reason).toBe("not_windows");
  });

  test("missing config.toml is not applicable on Windows", () => {
    const result = diagnoseCodexBundledPlugins({
      platform: "win32",
      configPath: join(tmpdir(), "definitely-missing-codex-config-xyz.toml"),
    });
    expect(result.applicable).toBe(false);
    if (!result.applicable) expect(result.reason).toBe("config_unreadable");
  });

  test("stale: local source that does not resolve to a manifest is flagged", () => {
    const stalePath = join(tmpdir(), "Codex_1.0.0", "plugins", "openai-bundled");
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(stalePath)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.stale).toBe(true);
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.resolvesToManifest).toBe(false);
        expect(result.suggestedRepair).not.toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("healthy: local source with a supported manifest resolves", () => {
    const marketRoot = mkdtempSync(join(tmpdir(), "ocx-bundled-root-"));
    mkdirSync(join(marketRoot, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(marketRoot, ".agents", "plugins", "marketplace.json"), "{}", "utf8");
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(marketRoot)}\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.stale).toBe(false);
        expect(result.marketplace.resolvesToManifest).toBe(true);
        expect(result.suggestedRepair).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(marketRoot, { recursive: true, force: true });
    }
  });

  test("absent marketplace entry is present:false and not stale", () => {
    const { dir, configPath } = makeConfig(`model = "gpt-5"\n`);
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(false);
        expect(result.stale).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registered source path is username-masked in output", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "C:\\\\Users\\\\alice\\\\AppData\\\\Codex_1.2.3\\\\openai-bundled"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.source).toContain("[USER]");
        expect(result.marketplace.source).not.toContain("alice");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects configured bundled plugin tables", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "X:\\\\gone"\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        const cu = result.bundledPlugins.find(p => p.id === "computer-use");
        expect(cu?.configured).toBe(true);
        const chrome = result.bundledPlugins.find(p => p.id === "chrome");
        expect(chrome?.configured).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a table header with a trailing inline comment", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled] # bundled\nsource_type = "local"\nsource = "X:\\\\gone"\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.stale).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF config with a header inline comment still parses (Windows native)", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]  # x\r\nsource_type = "local"\r\nsource = "X:\\\\gone"\r\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.present).toBe(true);
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.stale).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRLF config with key/value inline comments does not false-report healthy", () => {
    const { dir, configPath } = makeConfig(
      `[marketplaces.openai-bundled]\r\nsource_type = "local"  # t\r\nsource = "X:\\\\gone"  # p\r\n`,
    );
    try {
      const result = diagnoseCodexBundledPlugins({ platform: "win32", configPath });
      expect(result.applicable).toBe(true);
      if (result.applicable) {
        expect(result.marketplace.sourceType).toBe("local");
        expect(result.marketplace.source).not.toBeNull();
        expect(result.stale).toBe(true); // must NOT collapse to "ok"
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ocx status --json codexPlugins (spawned, read-only)", () => {
  test("status --json includes a codexPlugins block and never writes CODEX_HOME", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-home-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-codex-home-"));
    writeFileSync(join(codexHome, "config.toml"), `model = "gpt-5"\n`, "utf8");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 9, providers: {}, defaultProvider: "openai", codexAutoStart: false,
    }), "utf8");
    try {
      const before = readdirSync(codexHome).sort();
      const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome },
        encoding: "utf8",
      });
      const after = readdirSync(codexHome).sort();

      expect(result.status).toBe(0);
      expect(after).toEqual(before); // read-only: no files added to CODEX_HOME

      const parsed = JSON.parse(result.stdout) as {
        codexPlugins?: { applicable?: unknown };
      };
      expect(parsed.codexPlugins).toBeDefined();
      expect(typeof parsed.codexPlugins?.applicable).toBe("boolean");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
