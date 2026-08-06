import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function ownedEnvironment(codexHome: string, ocxHome: string): Record<string, string> {
  const home = join(ocxHome, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(ocxHome, "service-state.json"), JSON.stringify({
    version: 2,
    codexHome,
    opencodexHome: ocxHome,
    backend: "scheduler",
  }));
  if (process.platform === "darwin") {
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.opencodex.proxy.plist"), [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\"><dict><key>EnvironmentVariables</key><dict>",
      `<key>CODEX_HOME</key><string>${codexHome}</string>`,
      `<key>OPENCODEX_HOME</key><string>${ocxHome}</string>`,
      "</dict></dict></plist>",
    ].join("\n"));
  }
  return { HOME: home, USERPROFILE: home };
}

describe("ocx restore back", () => {
  test("restore durably disables Codex in an isolated home", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-cli-restore-codex-"));
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-restore-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", checkForUpdates: false }), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ocxHome), CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(ocxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF and plain `codex` now runs natively.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ocxHome, { recursive: true, force: true });
    }
  });

  test("sync treats durable OFF as a successful no-write policy result", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-off-codex-"));
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-off-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", clientIntegrations: { codex: false }, checkForUpdates: false }), "utf8");
      const before = statSync(configPath).mtimeMs;
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ocxHome), CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF; sync skipped and no Codex files changed.");
      expect(statSync(configPath).mtimeMs).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ocxHome, { recursive: true, force: true });
    }
  });

  test("sync exits nonzero when managed-default cleanup is ambiguous", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-codex-"));
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), [
        "# Managed by opencodex: native subagent defaults table",
        "[agents]",
        "# Managed by opencodex: native subagent default",
        "",
        'default_subagent_model = "gpt-5.6-sol"',
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture-key",
            allowPrivateNetwork: true,
            models: ["fixture-model"],
          },
        },
        defaultProvider: "fixture",
        checkForUpdates: false,
      }), "utf8");

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ocxHome), CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex config injection refused");
      expect(result.stderr).toContain("Codex sync did not complete");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ocxHome, { recursive: true, force: true });
    }
  });

  test("help documents both directions of the switch", () => {
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-help-home-"));
    try {
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
        providers: {}, defaultProvider: "openai", checkForUpdates: false,
      }), "utf8");
      const run = (...cliArgs: string[]) => spawnSync(process.execPath, ["run", "src/cli/index.ts", ...cliArgs], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: ocxHome, CI: "1" },
        encoding: "utf8",
      });
      const usage = run("help");
      expect(usage.status).toBe(0);
      expect(`${usage.stdout}\n${usage.stderr}`).toContain("ocx restore back");
      const restoreHelp = run("help", "restore");
      expect(restoreHelp.status).toBe(0);
      expect(`${restoreHelp.stdout}\n${restoreHelp.stderr}`).toContain("ocx restore [back]");
    } finally {
      rmSync(ocxHome, { recursive: true, force: true });
    }
  });
});
