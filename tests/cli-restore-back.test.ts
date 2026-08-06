import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helpSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "help.ts"), "utf8");
const repoRoot = join(import.meta.dir, "..");

describe("ocx restore back", () => {
  test("restore durably disables Codex in an isolated home", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-cli-restore-codex-"));
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-restore-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", checkForUpdates: false }), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
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
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
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
        providers: {},
        defaultProvider: "openai",
        checkForUpdates: false,
      }), "utf8");

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
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
    expect(helpSource).toContain("ocx restore [back]");
    expect(helpSource).toContain("ocx eject [back]");
    expect(helpSource).toContain("ocx restore back");
  });
});
