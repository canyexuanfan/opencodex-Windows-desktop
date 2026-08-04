import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

let testRoot = "";
let codexHome = "";
let opencodexHome = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-admission-")));
  codexHome = join(testRoot, "codex-home");
  opencodexHome = join(testRoot, "opencodex-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(testRoot, { recursive: true, force: true });
});

test("captures the given config reference, generation, and catalog target identities", () => {
  saveConfig(config(20200));
  const residentConfig = config(30300);
  writeFileSync(join(codexHome, "opencodex-catalog.json"), "{}\n");
  writeFileSync(join(codexHome, "models_cache.json"), "{}\n");

  const snapshot = captureCatalogAdmissionSnapshot(residentConfig);

  expect(snapshot.config).toBe(residentConfig);
  expect(snapshot.config.port).toBe(30300);
  expect(snapshot.generation).toBe(1);
  expect(JSON.parse(snapshot.targets.catalog)).toMatchObject({
    path: join(codexHome, "opencodex-catalog.json"),
    canonicalParent: codexHome,
    parentIdentity: { device: expect.any(String), inode: expect.any(String) },
    fileIdentity: { device: expect.any(String), inode: expect.any(String) },
  });
  expect(JSON.parse(snapshot.targets.cache)).toMatchObject({
    path: join(codexHome, "models_cache.json"),
    canonicalParent: codexHome,
    fileIdentity: { device: expect.any(String), inode: expect.any(String) },
  });
  expect(snapshot.targets.catalogBackups).toHaveLength(2);
});

test("changes target identity when a parent symlink retargets without changing the path", () => {
  const parentA = join(testRoot, "catalog-parent-a");
  const parentB = join(testRoot, "catalog-parent-b");
  const linkedParent = join(testRoot, "catalog-parent");
  mkdirSync(parentA);
  mkdirSync(parentB);
  symlinkSync(parentA, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const textualCatalogPath = join(linkedParent, "catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(textualCatalogPath)}\n`,
  );

  const before = JSON.parse(captureCatalogAdmissionSnapshot(config()).targets.catalog);
  if (process.platform === "win32") rmSync(linkedParent, { recursive: true, force: true });
  else unlinkSync(linkedParent);
  symlinkSync(parentB, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const after = JSON.parse(captureCatalogAdmissionSnapshot(config()).targets.catalog);

  expect(before.path).toBe(textualCatalogPath);
  expect(after.path).toBe(textualCatalogPath);
  expect(before.canonicalParent).not.toBe(after.canonicalParent);
  expect(before.parentIdentity).not.toEqual(after.parentIdentity);
});
