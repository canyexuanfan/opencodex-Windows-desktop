import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig } from "../src/grok/inject";

/**
 * #511 — Grok Build reported 200k for every model.
 *
 * `~/.grok/config.toml` accumulated a SECOND entry per model above the managed block,
 * written by a version that predates the fence. Those entries carry no `context_window`,
 * so Grok fell back to its own 200k default — and because they sit outside the fence,
 * `userModelAliases` reserved them as user-owned, so every sync wrote a correct `-2`
 * duplicate beside the stale original instead of replacing it. `[models] default` named
 * the stale one.
 *
 * Failure-mode ids below map to devlog/_plan/260727_grok_orphan_adoption/001.
 */

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const MODELS = [{ id: "gpt-5.6-sol", contextWindow: 372_000 }];

describe("Grok orphan adoption (#511)", () => {
  let root: string;
  let grokHome: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-orphan-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
    configPath = join(grokHome, "config.toml");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The real shape from a machine that hit #511. */
  function writeOrphanedConfig(extra = ""): void {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
      extra,
    ].join("\n"));
  }

  function modelTables(content: string): string[] {
    return [...content.matchAll(/^\[model\.([^\]]+)\]$/gm)].map(match => match[1]!);
  }

  test("adopts the stale entry so exactly one table per model survives", () => {
    writeOrphanedConfig();
    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    const tables = modelTables(content);
    expect(tables).toHaveLength(1);
    // The survivor is inside the fence and carries the authoritative window.
    expect(content.indexOf(`[model.${tables[0]}]`)).toBeGreaterThan(content.indexOf(BEGIN_MARKER));
    expect(content).toContain("context_window = 372000");
  });

  // F2: on a real machine `default` names the orphan, so this is the common path.
  test("repoints default at the surviving alias", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    const survivor = modelTables(content)[0]!;
    expect(content).toContain(`default = "${survivor}"`);
  });

  // F1: the worst outcome is deleting a model a human wrote. Loopback alone is legitimate.
  test("never adopts a hand-written model, even on a loopback base_url", () => {
    writeOrphanedConfig([
      "[model.my-own]",
      'model = "my-local"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "my-own-secret"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[model.my-own]");
    expect(content).toContain('api_key = "my-own-secret"');
  });

  // F1: our api_key pointed at a REMOTE host is not ours to delete.
  test("does not adopt our api_key when the base_url is remote", () => {
    writeFileSync(configPath, [
      "[model.ocx-remote]",
      'model = "gpt-5.6-sol"',
      'base_url = "https://example.com/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    expect(readFileSync(configPath, "utf8")).toContain("[model.ocx-remote]");
  });

  // F3: `[[model.x]]` collides with a generated `[model.x]` and makes Grok reject the
  // WHOLE config layer, so that spelling must stay reserved rather than adopted.
  test("leaves an array-of-table model reserved", () => {
    writeFileSync(configPath, [
      "[[model.ocx-arr]]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[[model.ocx-arr]]");
    expect(content).not.toContain("\n[model.ocx-arr]\n");
  });

  // F4: a partial removal would re-parent leftover keys onto the neighbouring table.
  test("removal keeps the following table intact", () => {
    writeOrphanedConfig([
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[ui]");
    expect(content).toContain('theme = "dark"');
    // No key from the removed table leaked into [ui].
    expect(content).not.toContain('api_backend = "chat_completions"\ntheme');
  });

  // F5: an orphan with no replacement stays, and its reference is not rewritten to
  // something arbitrary — a working config beats a dangling default.
  test("keeps an orphan whose model is no longer in the catalog", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-retired"',
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('default = "ocx-retired"');
  });

  // F7: the sweep must converge, or `changed` is meaningless to callers.
  test("is idempotent: the second sync reports no change", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });
    const afterFirst = readFileSync(configPath, "utf8");

    const second = injectGrokConfig(10100, MODELS, { grokHome });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
  });

  // F6: the sweep runs inside the normalized window, so the user's EOL survives.
  test("preserves CRLF line endings", () => {
    writeOrphanedConfig();
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/\n/g, "\r\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("\r\n");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });


  // The state a REAL machine reached (#511 field evidence): Grok re-serialized the file
  // into its own format and dropped our marker COMMENTS entirely. findManagedRegion then
  // returns null, so the whole file is in scope and the ownership predicate is the only
  // thing standing between the sweep and the user's own models.
  test("still adopts safely when Grok has dropped the markers entirely", () => {
    writeFileSync(configPath, [
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",            // stale: no context_window
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      "[model.ocx-gpt-5-6-sol-2]",          // the correct duplicate, also unfenced now
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "context_window = 372000",
      "",
      "[model.ocx-gpt-5-6-sol-2.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.hand-written]",               // must survive
      'model = "mine"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // Both opencodex duplicates collapse into the single regenerated entry.
    expect(modelTables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    expect(content).toContain("context_window = 372000");
    // The user's model and settings are untouched.
    expect(content).toContain("[model.hand-written]");
    expect(content).toContain('api_key = "not-ours"');
    expect(content).toContain('fork_secondary_model = "grok-build"');
    // default still resolves.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(content).toContain(`[model.${survivor}]`);
  });

  // F8: an ambiguous fence must refuse BEFORE the sweep, or "outside the region" could
  // mean the entire file.
  test("refuses to sweep when the end marker is missing", () => {
    const content = [
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      BEGIN_MARKER,
      "",
    ].join("\n");
    writeFileSync(configPath, content);

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: false, changed: false, skippedReason: "orphaned-marker" });
    expect(readFileSync(configPath, "utf8")).toBe(content);
  });
});
