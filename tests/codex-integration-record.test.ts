import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readIntegrationRecord,
  updateIntegrationRecord,
} from "../src/codex/integration-record";
import type { CodexIntegrationRecord } from "../src/codex/convergence-types";

let opencodexHome = "";
let previousOpencodexHome: string | undefined;

function integrationRecordPath(): string {
  return join(opencodexHome, "integrations", "codex.json");
}

function writeRecord(value: unknown): void {
  mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
  writeFileSync(integrationRecordPath(), JSON.stringify(value, null, 2));
}

function persistedRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(integrationRecordPath(), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-integration-record-"));
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

describe("Codex integration record", () => {
  test("accepts a v1 record written before provenance existed", () => {
    writeRecord({ version: 1 });

    expect(readIntegrationRecord()).toEqual({
      kind: "ready",
      record: { version: 1 },
    });
  });

  test("preserves future keys at record, ledger, entry, artifact, and both baseline levels", () => {
    writeRecord({
      version: 1,
      futureRecord: { mode: "newer" },
      provenance: {
        futureLedger: ["keep"],
        entries: [
          {
            artifact: { kind: "config", futureArtifact: { owner: "future-config" } },
            baseline: { kind: "absent", futureAbsentBaseline: 17 },
            postImage: "old-config-post-image",
            txId: "tx-config",
            at: "2026-08-04T00:00:00.000Z",
            futureEntry: { evidence: true },
          },
          {
            artifact: { kind: "generated-profile", futureArtifact: { owner: "future-profile" } },
            baseline: {
              kind: "present",
              sha256: "baseline-sha",
              bytesBase64: "YmFzZWxpbmU=",
              futurePresentBaseline: { codec: 2 },
            },
            postImage: "old-profile-post-image",
            txId: "tx-profile",
            at: "2026-08-04T00:00:01.000Z",
            futureEntry: { evidence: false },
          },
        ],
      },
    });

    const result = updateIntegrationRecord(record => ({
      version: 1,
      provenance: {
        entries: record.provenance!.entries.map((entry, index) => ({
          artifact: { kind: entry.artifact.kind } as typeof entry.artifact,
          baseline: entry.baseline.kind === "absent"
            ? { kind: "absent" }
            : {
                kind: "present",
                sha256: entry.baseline.sha256,
                bytesBase64: entry.baseline.bytesBase64,
              },
          postImage: `new-post-image-${index}`,
          txId: entry.txId,
          at: entry.at,
        })),
      },
    }));

    expect(result.kind).toBe("updated");
    const saved = persistedRecord();
    expect(saved.futureRecord).toEqual({ mode: "newer" });
    const ledger = saved.provenance as Record<string, unknown>;
    expect(ledger.futureLedger).toEqual(["keep"]);
    const entries = ledger.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.futureEntry).toEqual({ evidence: true });
    expect(entries[1]!.futureEntry).toEqual({ evidence: false });
    expect((entries[0]!.artifact as Record<string, unknown>).futureArtifact)
      .toEqual({ owner: "future-config" });
    expect((entries[1]!.artifact as Record<string, unknown>).futureArtifact)
      .toEqual({ owner: "future-profile" });
    expect((entries[0]!.baseline as Record<string, unknown>).futureAbsentBaseline).toBe(17);
    expect((entries[1]!.baseline as Record<string, unknown>).futurePresentBaseline)
      .toEqual({ codec: 2 });
    expect(entries.map(entry => entry.postImage)).toEqual(["new-post-image-0", "new-post-image-1"]);
  });

  test("fails closed on unparseable bytes without invoking the mutator or resetting the file", () => {
    mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
    writeFileSync(integrationRecordPath(), "{ definitely-not-json", "utf8");
    let invoked = false;

    const result = updateIntegrationRecord((record): CodexIntegrationRecord => {
      invoked = true;
      return record;
    });

    expect(result).toEqual({
      kind: "invalid",
      message: "Codex integration record contains invalid JSON",
    });
    expect(invoked).toBe(false);
    expect(readFileSync(integrationRecordPath(), "utf8")).toBe("{ definitely-not-json");
  });

  test("creates the minimal v1 record when the file is missing", () => {
    const result = updateIntegrationRecord(record => record);

    expect(result).toEqual({ kind: "updated", record: { version: 1 } });
    expect(persistedRecord()).toEqual({ version: 1 });
  });
});
