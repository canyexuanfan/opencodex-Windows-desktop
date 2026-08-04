import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { buildCatalogEntries } from "../src/codex/catalog";
import { buildProfileFile } from "../src/codex/inject";
import { classifyNativeRoutedResidue } from "../src/codex/native-residue";
import { readCodexTransitionState } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let opencodexHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-codex-"));
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-opencodex-"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(opencodexHome, { recursive: true, force: true });
});

function pathInCodexHome(name: string): string {
  return join(codexHome, name);
}

function routedCatalog(): string {
  const models = buildCatalogEntries(
    null,
    [],
    [{ provider: "fixture-provider", id: "fixture-model" }],
  );
  return JSON.stringify({ models }, null, 2) + "\n";
}

function createHistoryDatabase(modelProvider: "openai" | "opencodex"): void {
  const database = new Database(pathInCodexHome("state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0
    )
  `);
  database.query(`
    INSERT INTO threads (
      id, rollout_path, model_provider, source, first_user_message, has_user_event
    ) VALUES (?, ?, ?, 'cli', 'routed history', 1)
  `).run("thread-1", pathInCodexHome("rollout.jsonl"), modelProvider);
  database.close();
}

function historyBackupPath(): string {
  const databasePath = join(realpathSync.native(codexHome), "state_5.sqlite");
  const normalized = process.platform === "win32"
    ? resolve(databasePath).toLowerCase()
    : resolve(databasePath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(opencodexHome, `codex-history-backup-${id}.json`);
}

const residueFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "injected config.toml",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), [
      "# Auto-injected by opencodex",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n")),
  },
  {
    name: "generated profile",
    surface: "profile",
    arrange: () => writeFileSync(
      pathInCodexHome("opencodex.config.toml"),
      buildProfileFile(10100, null),
    ),
  },
  {
    name: "routed catalog",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json"), routedCatalog()),
  },
  {
    name: "routed models cache",
    surface: "models-cache",
    arrange: () => writeFileSync(pathInCodexHome("models_cache.json"), routedCatalog()),
  },
  {
    name: "restore journal",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model = "gpt-5.5"\n').toString("base64"),
      originalProfile: null,
      pid: 12345,
      timestamp: "2026-08-04T00:00:00.000Z",
    })),
  },
  {
    name: "history database row",
    surface: "history",
    arrange: () => createHistoryDatabase("opencodex"),
  },
  {
    name: "history backup entry",
    surface: "history-backup",
    arrange: () => writeFileSync(historyBackupPath(), JSON.stringify({
      version: 1,
      stateDbPath: join(realpathSync.native(codexHome), "state_5.sqlite"),
      entries: {
        "thread-1": {
          id: "thread-1",
          rolloutPath: pathInCodexHome("rollout.jsonl"),
          modelProvider: "openai",
          source: "cli",
          hasUserEvent: 1,
        },
      },
    })),
  },
];

for (const fixture of residueFixtures) {
  test(`${fixture.name} is structurally provable routed residue`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "residue",
      surface: fixture.surface,
    });
  });
}

test("an OpenCodex atomic-write artifact is indeterminate", () => {
  writeFileSync(pathInCodexHome("config.toml.ocx.123.1.tmp"), "partial");
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
  });
});

const indeterminateFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "malformed config TOML",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), 'model = "unterminated\n'),
  },
  {
    name: "malformed profile TOML",
    surface: "profile",
    arrange: () => writeFileSync(pathInCodexHome("opencodex.config.toml"), "[features\n"),
  },
  {
    name: "malformed catalog JSON",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json"), "{not-json"),
  },
  {
    name: "unreadable models cache shape",
    surface: "models-cache",
    arrange: () => mkdirSync(pathInCodexHome("models_cache.json")),
  },
  {
    name: "malformed journal JSON",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-journal.json"), "{not-json"),
  },
  {
    name: "partial write",
    surface: "partial-write",
    arrange: () => writeFileSync(pathInCodexHome("opencodex-catalog.json.ocx.42.7.tmp"), ""),
  },
  {
    name: "malformed history database",
    surface: "history",
    arrange: () => writeFileSync(pathInCodexHome("state_5.sqlite"), "not sqlite"),
  },
  {
    name: "malformed history backup",
    surface: "history-backup",
    arrange: () => writeFileSync(historyBackupPath(), "{not-json"),
  },
];

for (const fixture of indeterminateFixtures) {
  test(`${fixture.name} is indeterminate and refuses coordinator initialization`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: fixture.surface,
    });
    expect(readCodexTransitionState()).toEqual({
      kind: "legacy-ambiguous",
      message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    });
  });
}

const symlinkTest = process.platform === "win32" ? test.skip : test;
symlinkTest("an unresolvable surface symlink is indeterminate", () => {
  symlinkSync(pathInCodexHome("missing-config"), pathInCodexHome("config.toml"));
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
  });
});

test("an empty CODEX_HOME is clean and coordinator initialization succeeds", () => {
  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("user-owned non-OpenCodex content is clean and coordinator initialization succeeds", () => {
  writeFileSync(pathInCodexHome("config.toml"), 'model = "gpt-5.5"\n');
  writeFileSync(pathInCodexHome("notes.txt"), "user content\n");
  writeFileSync(pathInCodexHome("opencodex-catalog.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  writeFileSync(pathInCodexHome("models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  createHistoryDatabase("openai");

  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("CODEX_HOME is resolved at call time", () => {
  const secondHome = mkdtempSync(join(tmpdir(), "ocx-native-residue-second-codex-"));
  try {
    writeFileSync(join(secondHome, "opencodex.config.toml"), buildProfileFile(10100, null));
    expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
    process.env.CODEX_HOME = secondHome;
    expect(classifyNativeRoutedResidue()).toMatchObject({ kind: "residue", surface: "profile" });
  } finally {
    process.env.CODEX_HOME = codexHome;
    rmSync(secondHome, { recursive: true, force: true });
  }
});

test("a missing coordinator with only the generated profile refuses initialization", () => {
  writeFileSync(join(codexHome, "opencodex.config.toml"), buildProfileFile(10100, null));

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});
