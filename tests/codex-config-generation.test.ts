import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  bumpConfigGeneration,
  mutatePersistedConfig,
  readConfigGeneration,
  saveConfig,
  saveConfigPreservingClaudeCode,
} from "../src/config";
import type { OcxConfig } from "../src/types";

let testRoot = "";
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-codex-config-generation-"));
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(testRoot, { recursive: true, force: true });
});

test("an initial read creates the singleton generation at zero", () => {
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 0 },
  });
});

test("a cooperating save bumps once and an unchanged save does not bump", () => {
  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config(20200));
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 2 },
  });
});

test("every cooperating writer bumps only when its committed bytes change", () => {
  saveConfig(config());

  expect(mutatePersistedConfig(persisted => {
    persisted.port = 20200;
    return { changed: true, value: persisted.port };
  })).toEqual({ status: "committed", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  expect(mutatePersistedConfig(persisted => (
    { changed: false, value: persisted.port }
  ))).toEqual({ status: "unchanged", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
});

test("a stale expected value conflicts without changing the winner", () => {
  const admitted = readConfigGeneration();
  expect(admitted.kind).toBe("ready");
  if (admitted.kind !== "ready") throw new Error("generation unavailable");

  saveConfig(config());
  expect(bumpConfigGeneration(admitted.generation)).toEqual({
    kind: "conflict",
    current: { value: 1 },
  });
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("busy and unavailable databases return typed outcomes instead of throwing", () => {
  expect(readConfigGeneration().kind).toBe("ready");
  const databasePath = join(testRoot, "config-mutation.sqlite");
  const holder = new Database(databasePath, { readwrite: true, create: false });
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "busy" });
    expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "busy" });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }

  rmSync(testRoot, { recursive: true, force: true });
  writeFileSync(testRoot, "not a directory", "utf8");
  expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "database" });
});
