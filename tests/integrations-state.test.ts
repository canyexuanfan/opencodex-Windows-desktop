import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_CLIENTS, type ExportModel } from "../src/clients/config-export";
import { PARSE_FAILED, fileIO, loadTarget, parseConfig } from "../src/integrations/config-io";
import {
  canonicalContribution,
  fingerprint,
  writeRecord,
  type OwnershipRecord,
} from "../src/integrations/ownership";
import { classifyIntegration, readIntegrationState } from "../src/integrations/state";
import { createIntegrationStateStore } from "../src/integrations/store";
import type { OcxConfig } from "../src/types";

/**
 * Activation coverage for devlog/_plan/260802_client_toggle_api/021 §6.
 *
 * Every fixture is built DIRECTLY on disk — write a config, write a record,
 * classify — because the writer does not exist until WP3 and a phase that
 * cannot verify itself is not a phase boundary.
 */
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

let home: string;
let stateRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-integrations-state-"));
  stateRoot = join(home, "state", "integrations");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function store() {
  return createIntegrationStateStore(stateRoot);
}

function input(overrides: Partial<Parameters<typeof readIntegrationState>[0]> = {}) {
  return {
    clientId: "pi" as const,
    models: MODELS,
    config: CONFIG,
    port: 10100,
    home,
    store: store(),
    ...overrides,
  };
}

/** Write a Pi config carrying our provider entry, and return its exact text. */
function seedOurConfig(): string {
  const document = EXPORT_CLIENTS.pi.build({
    baseUrl: "http://127.0.0.1:10100/v1",
    models: MODELS,
    config: CONFIG,
  });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(home, ".pi", "agent", "models.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path, text);
  return text;
}

function seedRecord(fileText: string, blockOverride?: string): OwnershipRecord {
  const contribution = EXPORT_CLIENTS.pi.buildContribution({
    baseUrl: "http://127.0.0.1:10100/v1",
    models: MODELS,
    config: CONFIG,
  });
  const record: OwnershipRecord = {
    clientId: "pi",
    configPath: join(home, ".pi", "agent", "models.json"),
    fileFingerprint: fingerprint(fileText),
    blockFingerprint: blockOverride ?? fingerprint(canonicalContribution(contribution)),
    fragmentPaths: contribution.fragments.map(fragment => fragment.path),
    appliedAt: "2026-08-02T00:00:00.000Z",
    opId: "seeded-op",
  };
  writeRecord(record, stateRoot);
  return record;
}

describe("the five states, each triggered directly", () => {
  test("absent: a clean config with no entry of ours", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), "{}\n");
    expect(readIntegrationState(input()).state).toBe("absent");
  });

  test("absent: no file at all", () => {
    expect(readIntegrationState(input()).state).toBe("absent");
  });

  test("current: our entry, untouched, equal to a fresh build", () => {
    seedRecord(seedOurConfig());
    const status = readIntegrationState(input());
    expect(status.state).toBe("current");
    expect(status.lastOpId).toBe("seeded-op");
  });

  test("stale: untouched, but no longer what we would write now", () => {
    // Same file, but the record remembers a different contribution.
    seedRecord(seedOurConfig(), fingerprint("a-previous-catalog"));
    expect(readIntegrationState(input()).state).toBe("stale");
  });

  test("conflict: the file changed after we wrote it", () => {
    const text = seedOurConfig();
    seedRecord(text);
    // A user edit after our write: the file hash no longer matches.
    writeFileSync(join(home, ".pi", "agent", "models.json"), `${text}\n`);
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("foreign-edit");
  });

  test("conflict: our key exists with no ownership record at all", () => {
    seedOurConfig();
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("unowned-key");
  });

  test("unsafe: the config path is a directory", () => {
    mkdirSync(join(home, ".pi", "agent", "models.json"), { recursive: true });
    const status = readIntegrationState(input());
    expect(status.state).toBe("unsafe");
    expect(status.reason).toBe("not-regular-file");
  });

  test("unsafe: the file cannot be parsed", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), "{{{\n");
    const status = readIntegrationState(input());
    expect(status.state).toBe("unsafe");
    expect(status.reason).toBe("unparseable");
  });
});

describe("ordering guards", () => {
  test("an unreadable file is never reported as absent", () => {
    // stat says file, read fails: a real file we cannot see.
    const io = {
      ...fileIO(),
      statKind: () => "file" as const,
      readText: () => ({ kind: "failed" as const, code: "EACCES" }),
      appendJournal: () => {},
      putRecord: () => {},
      dropRecord: () => {},
    };
    const status = readIntegrationState(input({ io }));
    expect(status.state).toBe("unsafe");
    expect(status.state).not.toBe("absent");
  });

  test("a foreign edit is never reported as stale", () => {
    // Both axes differ: the file changed AND the contribution moved on. The
    // foreign edit must win, because reporting drift here would let a later
    // disable delete the user's change.
    const text = seedOurConfig();
    seedRecord(text, fingerprint("a-previous-catalog"));
    writeFileSync(join(home, ".pi", "agent", "models.json"), `${text} `);
    const status = readIntegrationState(input());
    expect(status.state).toBe("conflict");
    expect(status.reason).toBe("foreign-edit");
  });

  test("a stat failure is not absence either", () => {
    const io = {
      ...fileIO(),
      statKind: () => "failed" as const,
      appendJournal: () => {},
      putRecord: () => {},
      dropRecord: () => {},
    };
    expect(loadTarget(io, "/nowhere").ok).toBe(false);
  });
});

describe("classifier unit behavior", () => {
  const contribution = EXPORT_CLIENTS.pi.buildContribution({
    baseUrl: "http://127.0.0.1:10100/v1",
    models: MODELS,
    config: CONFIG,
  });

  test("a document whose container is an array reads as absent, not a throw", () => {
    const result = classifyIntegration({
      fileText: "{}",
      fileIsRegular: true,
      parsed: { providers: [] },
      record: null,
      contribution,
    });
    expect(result.state).toBe("absent");
  });

  test("PARSE_FAILED short-circuits before any fragment lookup", () => {
    const result = classifyIntegration({
      fileText: "{{{",
      fileIsRegular: true,
      parsed: PARSE_FAILED,
      record: null,
      contribution,
    });
    expect(result).toEqual({ state: "unsafe", reason: "unparseable" });
  });

  test("parseConfig treats an empty file as an empty document, not a failure", () => {
    expect(parseConfig("", "json")).toEqual({});
    expect(parseConfig(null, "yaml")).toEqual({});
    expect(parseConfig("{{{", "json")).toBe(PARSE_FAILED);
  });

  test("fragment order does not change the contribution fingerprint", () => {
    const reversed = { ...contribution, fragments: [...contribution.fragments].reverse() };
    expect(canonicalContribution(reversed)).toBe(canonicalContribution(contribution));
  });
});

describe("installation detection is independent of config state", () => {
  test("installed is false when the client's directory is absent", () => {
    expect(readIntegrationState(input()).installed).toBe(false);
  });

  test("installed is true once the directory exists, even with no config", () => {
    mkdirSync(join(home, ".pi"), { recursive: true });
    const status = readIntegrationState(input());
    expect(status.installed).toBe(true);
    expect(status.state).toBe("absent");
  });
});
