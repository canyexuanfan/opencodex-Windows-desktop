import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNativeProfileJournal,
  MAX_NATIVE_PROFILE_JOURNAL_BYTES,
  MAX_NATIVE_PROFILE_METADATA_BYTES,
  OsNativeProfileKeyProvider,
  readNativeProfileVault,
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
const REPLACEMENT_TRANSACTION_ID = "44444444-4444-4444-8444-444444444444";
const BOUNDED_READ_TEST_SEAM = Symbol.for("opencodex.native-profile-store.bounded-read-test-seam");

interface BoundedReadTestSeam {
  afterValidatedOpen?: (path: string, fd: number) => void;
  onBufferAllocated?: (byteLength: number) => void;
  onRead?: (requestedBytes: number, bytesRead: number, totalBytesRead: number) => void;
}

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

function installBoundedReadTestSeam(store: NativeProfileContext, seam: BoundedReadTestSeam): void {
  (store as NativeProfileContext & { [key: symbol]: unknown })[BOUNDED_READ_TEST_SEAM] = seam;
}

function expectZeroized(buffer: Buffer): void {
  expect([...buffer].every(byte => byte === 0)).toBe(true);
}

class TestKeyringEntry {
  private written: Buffer | null = null;
  private getCalls = 0;
  constructor(
    private readonly initial: Buffer | null,
    private readonly readback?: Buffer | null,
    private readonly readError?: Error,
    private readonly writeError?: Error,
  ) {}
  async setSecret(secret: Uint8Array): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.written = Buffer.from(secret);
  }
  async getSecret(): Promise<Buffer | null> {
    if (this.readError) throw this.readError;
    this.getCalls += 1;
    if (this.getCalls === 1) return this.initial;
    return this.readback ?? this.written;
  }
}

function keyringProvider(
  entry: TestKeyringEntry,
  buffers: Buffer[],
): OsNativeProfileKeyProvider {
  return new OsNativeProfileKeyProvider({
    entryFactory: async () => entry,
    onSecretBufferCreated: buffer => buffers.push(buffer),
  });
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

function journal(transactionId = TRANSACTION_ID): NativeProfileSwitchJournalV1 {
  return {
    version: 1,
    transactionId,
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
  const correlatedPadding = Math.floor(paddingBytes / 2);
  value.sourcePayload.keyRef += "x".repeat(correlatedPadding);
  value.afterVault.profiles.find(profile => profile.id === SOURCE_ID)!.payload!.keyRef
    += "x".repeat(correlatedPadding);
  value.createdAt += "x".repeat(paddingBytes - correlatedPadding * 2);
  return value;
}

function inspectJournal(value: NativeProfileSwitchJournalV1) {
  const store = context();
  writeFileSync(store.journalPath, serializeNativeProfileJournal(value));
  return inspectNativeProfileJournal(store);
}

describe("native-profile recovery journal storage", () => {
  test("accepts correlated forward and rollback-preservation journals", () => {
    for (const phase of ["prepared", "auth-replaced", "vault-committed"] as const) {
      const forward = journal();
      forward.phase = phase;
      expect(inspectJournal(forward).status).toBe("valid");
    }

    const preservedRollback = journal();
    const refreshedTargetPayload = payload("d".repeat(64));
    const beforeTarget = preservedRollback.beforeVault.profiles.find(profile => profile.id === TARGET_ID)!;
    preservedRollback.targetPayload = refreshedTargetPayload;
    beforeTarget.payload = refreshedTargetPayload;
    beforeTarget.updatedAt = "2026-08-02T00:01:00.000Z";
    preservedRollback.beforeVault.revision += 1;

    expect(inspectJournal(preservedRollback).status).toBe("valid");
  });

  test("rejects independently valid vault snapshots with corrupt switch correlations", () => {
    const corruptions: Array<[string, (value: NativeProfileSwitchJournalV1) => void]> = [
      ["source profile id", value => { value.sourceProfileId = TARGET_ID; }],
      ["target profile id", value => { value.targetProfileId = SOURCE_ID; }],
      ["source identity hash", value => { value.sourceIdentityHash = "d".repeat(64); }],
      ["target identity hash", value => { value.targetIdentityHash = "e".repeat(64); }],
      ["before active profile", value => { value.beforeVault = vault("target"); }],
      ["after active profile", value => { value.afterVault = vault("source"); }],
      ["swapped payloads", value => {
        [value.sourcePayload, value.targetPayload] = [value.targetPayload, value.sourcePayload];
      }],
      ["missing target payload placement", value => {
        value.beforeVault.profiles = value.beforeVault.profiles.filter(profile => profile.id !== TARGET_ID);
      }],
      ["missing source payload placement", value => {
        value.afterVault.profiles = value.afterVault.profiles.filter(profile => profile.id !== SOURCE_ID);
      }],
      ["after profile metadata", value => {
        value.afterVault.profiles.find(profile => profile.id === SOURCE_ID)!.label = "changed-source";
      }],
      ["after revision", value => { value.afterVault.revision += 1; }],
    ];

    for (const [name, corrupt] of corruptions) {
      const value = journal();
      corrupt(value);
      expect(inspectJournal(value), name).toEqual({ status: "invalid" });
    }
  });

  test("accepts and reads a compact journal exactly at the 17 MiB boundary", () => {
    const store = context();
    const serialized = serializeNativeProfileJournal(journalAtExactLimit());
    const allocations: number[] = [];
    let totalBytesRead = 0;
    installBoundedReadTestSeam(store, {
      onBufferAllocated: byteLength => allocations.push(byteLength),
      onRead: (_requestedBytes, _bytesRead, total) => { totalBytesRead = total; },
    });

    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_NATIVE_PROFILE_JOURNAL_BYTES);
    writeFileSync(store.journalPath, serialized);

    const inspection = inspectNativeProfileJournal(store);
    expect(inspection.status).toBe("valid");
    if (inspection.status === "valid") {
      expect(inspection.journal.transactionId).toBe(TRANSACTION_ID);
      expect(inspection.journal.phase).toBe("prepared");
    }
    expect(allocations).toEqual([MAX_NATIVE_PROFILE_JOURNAL_BYTES + 1]);
    expect(totalBytesRead).toBe(MAX_NATIVE_PROFILE_JOURNAL_BYTES);
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

  test("reads the opened descriptor when the journal path is replaced after validation", () => {
    const store = context();
    writeFileSync(store.journalPath, serializeNativeProfileJournal(journal()));
    installBoundedReadTestSeam(store, {
      afterValidatedOpen: path => {
        renameSync(path, path + ".opened");
        writeFileSync(path, serializeNativeProfileJournal(journal(REPLACEMENT_TRANSACTION_ID)));
      },
    });

    const inspection = inspectNativeProfileJournal(store);

    expect(inspection.status).toBe("valid");
    if (inspection.status === "valid") {
      expect(inspection.journal.transactionId).toBe(TRANSACTION_ID);
    }
  });

  test("reads at most vault cap plus one when the opened vault grows after fstat", () => {
    const store = context();
    const initial = JSON.stringify(vault("source")) + "\n";
    writeFileSync(store.vaultPath, initial);
    const allocations: number[] = [];
    let totalBytesRead = 0;
    installBoundedReadTestSeam(store, {
      afterValidatedOpen: path => {
        appendFileSync(path, Buffer.alloc(MAX_NATIVE_PROFILE_METADATA_BYTES + 2 - Buffer.byteLength(initial), 0x20));
      },
      onBufferAllocated: byteLength => allocations.push(byteLength),
      onRead: (_requestedBytes, _bytesRead, total) => { totalBytesRead = total; },
    });

    let caught: unknown;
    try { readNativeProfileVault(store); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("VAULT_INVALID");
    expect(allocations).toEqual([MAX_NATIVE_PROFILE_METADATA_BYTES + 1]);
    expect(totalBytesRead).toBe(MAX_NATIVE_PROFILE_METADATA_BYTES + 1);
  });

  test("reads at most journal cap plus one when the opened journal grows after fstat", () => {
    const store = context();
    const initial = serializeNativeProfileJournal(journal());
    writeFileSync(store.journalPath, initial);
    const allocations: number[] = [];
    let totalBytesRead = 0;
    installBoundedReadTestSeam(store, {
      afterValidatedOpen: path => {
        appendFileSync(path, Buffer.alloc(MAX_NATIVE_PROFILE_JOURNAL_BYTES + 2 - Buffer.byteLength(initial), 0x20));
      },
      onBufferAllocated: byteLength => allocations.push(byteLength),
      onRead: (_requestedBytes, _bytesRead, total) => { totalBytesRead = total; },
    });

    expect(inspectNativeProfileJournal(store)).toEqual({ status: "invalid" });
    expect(allocations).toEqual([MAX_NATIVE_PROFILE_JOURNAL_BYTES + 1]);
    expect(totalBytesRead).toBe(MAX_NATIVE_PROFILE_JOURNAL_BYTES + 1);
  });

  test("keyring get zeroizes the provider-owned secret after returning a copied key", async () => {
    const original = Buffer.alloc(32, 0x2a);
    const buffers: Buffer[] = [];
    const key = await keyringProvider(new TestKeyringEntry(original), buffers).get(HOME_ID);

    expect(key).not.toBeNull();
    expectZeroized(original);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toEqual(key!.key);
    expect(buffers[0].some(byte => byte !== 0)).toBe(true);
    key!.key.fill(0);
    expectZeroized(buffers[0]);
  });

  test("keyring get zeroizes both original and copy on invalid length", async () => {
    const original = Buffer.alloc(8, 0x2a);
    const buffers: Buffer[] = [];
    let caught: unknown;
    try { await keyringProvider(new TestKeyringEntry(original), buffers).get(HOME_ID); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("KEYRING_UNAVAILABLE");
    expectZeroized(original);
    expect(buffers).toHaveLength(1);
    expectZeroized(buffers[0]);
  });

  test("keyring get preserves the mapped error when the provider throws", async () => {
    const buffers: Buffer[] = [];
    let caught: unknown;
    try {
      await keyringProvider(new TestKeyringEntry(null, null, new Error("injected keyring read")), buffers).get(HOME_ID);
    } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("KEYRING_UNAVAILABLE");
    expect(buffers).toHaveLength(0);
  });

  test("keyring create zeroizes originals and verification copies on readback mismatch", async () => {
    const returned = Buffer.alloc(32, 0x2a);
    const buffers: Buffer[] = [];
    let caught: unknown;
    try { await keyringProvider(new TestKeyringEntry(null, returned), buffers).create(HOME_ID); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("KEYRING_UNAVAILABLE");
    expectZeroized(returned);
    expect(buffers.length).toBe(2);
    for (const buffer of buffers) expectZeroized(buffer);
  });

  test("keyring create zeroizes its generated key when writing throws", async () => {
    const buffers: Buffer[] = [];
    let caught: unknown;
    try {
      await keyringProvider(new TestKeyringEntry(null, null, undefined, new Error("injected keyring write")), buffers).create(HOME_ID);
    } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("KEYRING_UNAVAILABLE");
    expect(buffers).toHaveLength(1);
    expectZeroized(buffers[0]);
  });

  test("keyring create preserves copied key ownership on verified success", async () => {
    const buffers: Buffer[] = [];
    const created = await keyringProvider(new TestKeyringEntry(null), buffers).create(HOME_ID);

    expect(buffers.length).toBe(3);
    expectZeroized(buffers[0]);
    expectZeroized(buffers[1]);
    expect(created.key).toBe(buffers[2]);
    expect(created.key.some(byte => byte !== 0)).toBe(true);
    created.key.fill(0);
    expectZeroized(buffers[2]);
  });
});
