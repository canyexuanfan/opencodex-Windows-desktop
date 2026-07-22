import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOpenAiTierBackupAfterInit } from "../src/cli/init";
import { classifyOpenAiTierBackup } from "../src/config";

describe("cleanupOpenAiTierBackupAfterInit", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-init-backup-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("no-op when no backup exists", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes a stale post-migration (v2) backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, JSON.stringify({ openaiProviderTierVersion: 2, port: 10100, providers: {} }));
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes an unparseable backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, "not-json{{{");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
  });

  test("preserves a valid pre-migration (v1) rollback snapshot by renaming it", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    const preserved = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(v1);
  });

  test("classifyOpenAiTierBackup shares the migration policy", () => {
    const enc = (value: string) => new TextEncoder().encode(value);
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 2 })))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc("garbage"))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 1 })))).toBe("rollback");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({})))).toBe("rollback");
  });
});
