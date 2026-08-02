import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNativeProfileJournal,
  MAX_NATIVE_PROFILE_JOURNAL_BYTES,
  serializeNativeProfileJournal,
  type NativeProfileContext,
} from "../src/codex/native-profile-store";
import {
  NativeProfileError,
  type EncryptedNativeEnvelopeV1,
  type NativeMainProfileRecordV1,
  type NativeMainProfileVaultV1,
  type NativeProfileSwitchJournalV1,
} from "../src/codex/native-profile-types";

const roots: string[] = [];
const HOME_ID = "a".repeat(64);
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_HASH = "b".repeat(64);
const TARGET_HASH = "c".repeat(64);
const CREATED_AT = "2026-08-02T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(): NativeProfileContext {
  const rootDir = mkdtempSync(join(tmpdir(), "ocx-native-profile-store-"));
  roots.push(rootDir);
  return {
    codexHome: rootDir,
    configDir: rootDir,
    rootDir,
    stagingRoot: join(rootDir, "staging"),
    homeId: HOME_ID,
    authPath: join(rootDir, "auth.json"),
    vaultPath: join(rootDir, "profiles.vault.json"),
    journalPath: join(rootDir, "profiles.journal.json"),
    recoveryBlockPath: join(rootDir, "recovery-block.json"),
    lockPath: join(rootDir, "profiles.lock.sqlite"),
  };
}

function payload(identityHash: string): EncryptedNativeEnvelopeV1 {
  return {
    cipher: "aes-256-gcm",
    keyRef: "test:key",
    nonce: "AAECAwQFBgcICQoL",
    ciphertext: "eA==",
    tag: "AAECAwQFBgcICQoLDA0ODw==",
    envelopeSha256: identityHash,
  };
}

function profile(
  id: string,
  label: string,
  identityHash: string,
  state: "active" | "inactive",
  encryptedPayload: EncryptedNativeEnvelopeV1 | null,
): NativeMainProfileRecordV1 {
  return {
    id,
    label,
    identityHash,
    identityHint: `account-${identityHash.slice(0, 8)}`,
    state,
    payload: encryptedPayload,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function vault(active: "source" | "target"): NativeMainProfileVaultV1 {
  const sourceIsActive = active === "source";
  return {
    version: 1,
    revision: sourceIsActive ? 1 : 2,
    homeId: HOME_ID,
    activeProfileId: sourceIsActive ? SOURCE_ID : TARGET_ID,
    profiles: [
      profile(SOURCE_ID, "source", SOURCE_HASH, sourceIsActive ? "active" : "inactive", sourceIsActive ? null : payload(SOURCE_HASH)),
      profile(TARGET_ID, "target", TARGET_HASH, sourceIsActive ? "inactive" : "active", sourceIsActive ? payload(TARGET_HASH) : null),
    ],
  };
}

function journal(): NativeProfileSwitchJournalV1 {
  return {
    version: 1,
    transactionId: TRANSACTION_ID,
    homeId: HOME_ID,
    phase: "prepared",
    sourceProfileId: SOURCE_ID,
    sourceIdentityHash: SOURCE_HASH,
    sourcePayload: payload(SOURCE_HASH),
    targetProfileId: TARGET_ID,
    targetIdentityHash: TARGET_HASH,
    targetPayload: payload(TARGET_HASH),
    beforeVault: vault("source"),
    afterVault: vault("target"),
    createdAt: CREATED_AT,
  };
}

function journalAtExactLimit(): NativeProfileSwitchJournalV1 {
  const value = journal();
  const baseline = Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
  const paddingBytes = MAX_NATIVE_PROFILE_JOURNAL_BYTES - baseline;
  if (paddingBytes <= 0) throw new Error("journal fixture unexpectedly exceeds its target boundary");
  value.sourcePayload.keyRef += "x".repeat(paddingBytes);
  return value;
}

describe("native-profile recovery journal storage", () => {
  test("accepts and reads a compact journal exactly at the 17 MiB boundary", () => {
    const store = context();
    const serialized = serializeNativeProfileJournal(journalAtExactLimit());

    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_NATIVE_PROFILE_JOURNAL_BYTES);
    writeFileSync(store.journalPath, serialized);

    const inspection = inspectNativeProfileJournal(store);
    expect(inspection.status).toBe("valid");
    if (inspection.status === "valid") {
      expect(inspection.journal.transactionId).toBe(TRANSACTION_ID);
      expect(inspection.journal.phase).toBe("prepared");
    }
  });

  test("rejects a compact journal one byte over the 17 MiB boundary", () => {
    const store = context();
    const value = journalAtExactLimit();
    value.sourcePayload.keyRef += "x";

    let caught: unknown;
    try { serializeNativeProfileJournal(value); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("PROFILE_METADATA_TOO_LARGE");
    const serialized = JSON.stringify(value) + "\n";
    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_NATIVE_PROFILE_JOURNAL_BYTES + 1);
    writeFileSync(store.journalPath, serialized);
    expect(inspectNativeProfileJournal(store)).toEqual({ status: "invalid" });
  });
});
