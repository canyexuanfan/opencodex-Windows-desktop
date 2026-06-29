import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(codexHome: string, opencodexHome: string, script: string): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function nativeEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  };
}

describe("Codex catalog sync hardening", () => {
  let codexHome: string;
  let opencodexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-sync-home-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-sync-ocx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) rmSync(codexHome, { recursive: true, force: true });
    if (existsSync(opencodexHome)) rmSync(opencodexHome, { recursive: true, force: true });
  });

  test("Gap B: drops legacy OpenAI-family natives but keeps supported + user natives", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("gpt-5.4", 1),
        nativeEntry("gpt-5.4-mini", 2),
        nativeEntry("gpt-5.3-codex-spark", 3),
        nativeEntry("gpt-5.3-codex", 104),   // legacy -> drop
        nativeEntry("gpt-5.2", 104),          // legacy -> drop
        nativeEntry("codex-auto-review", 104),// legacy -> drop
        nativeEntry("user-native", 10),       // user-added -> keep
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex-catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("gpt-5.4");
    expect(slugs).toContain("gpt-5.4-mini");
    expect(slugs).toContain("gpt-5.3-codex-spark");
    expect(slugs).toContain("user-native");           // genuine user native preserved
    expect(slugs).not.toContain("gpt-5.3-codex");      // legacy dropped
    expect(slugs).not.toContain("gpt-5.2");            // legacy dropped
    expect(slugs).not.toContain("codex-auto-review");  // legacy dropped
  });

  test("Gap A: an empty routed fetch preserves existing routed entries on disk", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        { slug: "kiro/claude-opus-4.8", display_name: "kiro", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
        { slug: "opencode-go/glm-5.2", display_name: "go", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
      ],
    }, null, 2) + "\n");

    // config has NO providers => gatherRoutedModels returns [] (transient empty fetch).
    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex-catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");   // routed preserved despite empty fetch
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).toContain("gpt-5.5");
  });
});
