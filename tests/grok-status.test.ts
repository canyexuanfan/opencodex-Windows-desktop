import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig } from "../src/grok/inject";
import { readGrokStatus } from "../src/grok/status";

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-status-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

describe("readGrokStatus", () => {
  test("reports absent when there is no config at all", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const status = readGrokStatus({ grokHome });
      expect(status.present).toBe(false);
      expect(status.models).toEqual([]);
      expect(status.configPath).toBe(join(grokHome, "config.toml"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports absent when a config exists but carries no managed fence", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      writeFileSync(join(grokHome, "config.toml"), '[model.mine]\nmodel = "my-model"\n', "utf8");
      expect(readGrokStatus({ grokHome }).present).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The reader parses the exact block `buildGrokManagedBlock` emits, so it is verified against
  // real injector output rather than a hand-written fixture that could drift from the writer.
  test("reads back what the injector wrote, including context windows", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = injectGrokConfig(10190, [
        { id: "gpt-5.6-sol", contextWindow: 372_000 },
        { id: "cursor/grok-4.5", contextWindow: 500_000 },
        { id: "no-window-model" },
      ], { grokHome });
      expect(result.ok).toBe(true);

      const status = readGrokStatus({ grokHome });
      expect(status.present).toBe(true);
      expect(status.baseUrl).toBe("http://127.0.0.1:10190/v1");
      expect(status.models.map(m => `${m.id}:${m.contextWindow ?? "none"}`)).toEqual([
        "gpt-5.6-sol:372000",
        "cursor/grok-4.5:500000",
        "no-window-model:none",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // User content outside the fence can legitimately hold real credentials. The reader must not
  // surface any of it — only the region we ourselves emit.
  test("ignores everything outside the managed fence", () => {
    const { root, grokHome } = tempGrokHome();
    try {
      injectGrokConfig(10190, [{ id: "gpt-5.6-sol", contextWindow: 372_000 }], { grokHome });
      const path = join(grokHome, "config.toml");
      const existing = readFileSync(path, "utf8");
      writeFileSync(path, `[model.private]\nmodel = "secret-model"\napi_key = "sk-user-secret"\n\n${existing}`, "utf8");

      const status = readGrokStatus({ grokHome });
      expect(status.models.map(m => m.id)).toEqual(["gpt-5.6-sol"]);
      expect(JSON.stringify(status)).not.toContain("sk-user-secret");
      expect(JSON.stringify(status)).not.toContain("secret-model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
