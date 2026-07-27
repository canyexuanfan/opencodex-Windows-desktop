import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup star prompt", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("ocx start waits for the interactive prompt before sync/injection", async () => {
    const cli = await readText("src/cli/index.ts");
    const promptIndex = cli.indexOf("await maybeShowStarPrompt()");
    const syncIndex = cli.indexOf("await syncModelsToCodex(port)");

    expect(cli).not.toContain("void maybeShowStarPrompt()");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(syncIndex);
  });

  test("GitHub star prompt asks with an explicit Yes/No selector defaulting to No", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    expect(prompt).toContain("interactiveConfirm");
    expect(prompt).toContain("defaultYes: false");
    // The old typed prompt treated a bare Enter as consent.
    expect(prompt).not.toContain('ans === "" || ans === "y"');
  });

  test("the star prompt only appears when gh can actually star", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    expect(prompt).toContain('spawnSync("gh", ["auth", "status"]');
    expect(prompt).toContain("if (!ghAvailable()) return;");
  });

  test("declining the star prompt does not steer the agent afterwards", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // A "No" ends the feature: no persisted decline state, and nothing injected
    // into any model prompt to keep nudging the user later.
    expect(prompt).toContain("if (!yes) return;");
    expect(prompt).not.toMatch(/declined/i);
    expect(prompt).not.toMatch(/system\s*prompt|encourage|remind the user/i);
  });

  test("ocx init offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");

    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
